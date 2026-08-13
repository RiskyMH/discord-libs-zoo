package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/bwmarrin/discordgo"
	_ "modernc.org/sqlite"
)

const requiredPermissions = int64(discordgo.PermissionBanMembers | discordgo.PermissionManageChannels)

var db *sql.DB

func main() {
	token := os.Getenv("DISCORD_TOKEN")
	if token == "" {
		log.Fatal("DISCORD_TOKEN is required")
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "bot.db"
	}

	var err error
	db, err = sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS honeypots (
		guild_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		action TEXT NOT NULL DEFAULT 'ban',
		log_channel_id TEXT
	)`)
	if err != nil {
		log.Fatalf("Failed to create table: %v", err)
	}

	session, err := discordgo.New("Bot " + token)
	if err != nil {
		log.Fatalf("Failed to create session: %v", err)
	}
	session.Identify.Intents = discordgo.IntentGuilds | discordgo.IntentGuildMessages
	session.Identify.Presence = discordgo.GatewayStatusUpdate{
		Status: string(discordgo.StatusOnline),
		Game: discordgo.Activity{
			Name:  "Custom Status",
			Type:  discordgo.ActivityTypeCustom,
			State: "Watching #honeypot for bots",
		},
	}

	session.AddHandler(onReady)
	session.AddHandler(onInteractionCreate)
	session.AddHandler(onMessageCreate)
	session.AddHandler(onChannelDelete)
	session.AddHandler(onGuildDelete)

	if err = session.Open(); err != nil {
		log.Fatalf("Failed to connect to Discord: %v", err)
	}
	defer session.Close()

	log.Println("Bot is running. Press CTRL-C to exit.")
	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM)
	<-sc
}

func onReady(s *discordgo.Session, r *discordgo.Ready) {
	defaultMemberPermissions := requiredPermissions
	commands := []*discordgo.ApplicationCommand{
		{
			Name:                     "honeypot-set",
			Description:              "Set/update honeypot channel (note: this overrides previous config set)",
			DefaultMemberPermissions: &defaultMemberPermissions,
			Contexts:                 &[]discordgo.InteractionContextType{discordgo.InteractionContextGuild},
			IntegrationTypes:         &[]discordgo.ApplicationIntegrationType{discordgo.ApplicationIntegrationGuildInstall},
			Options: []*discordgo.ApplicationCommandOption{
				{
					Type:         discordgo.ApplicationCommandOptionChannel,
					Name:         "channel",
					Description:  "The channel to ban people that message in it",
					Required:     true,
					ChannelTypes: []discordgo.ChannelType{discordgo.ChannelTypeGuildText},
				},
				{
					Type:        discordgo.ApplicationCommandOptionString,
					Name:        "action",
					Description: "The action to take when someone messages in the honeypot channel",
					Required:    true,
					Choices: []*discordgo.ApplicationCommandOptionChoice{
						{Name: "Ban", Value: "ban"},
						{Name: "Softban", Value: "softban"},
						{Name: "Disabled", Value: "disabled"},
					},
				},
				{
					Type:         discordgo.ApplicationCommandOptionChannel,
					Name:         "log_channel",
					Description:  "The channel to log actions in (if ommited, then it won't log anywhere)",
					Required:     false,
					ChannelTypes: []discordgo.ChannelType{discordgo.ChannelTypeGuildText, discordgo.ChannelTypeGuildPublicThread, discordgo.ChannelTypeGuildPrivateThread},
				},
			},
		},
	}

	log.Printf("Logged in as %s#%s", r.User.Username, r.User.Discriminator)

	if _, err := s.ApplicationCommandBulkOverwrite(s.State.User.ID, "", commands); err != nil {
		log.Printf("Failed to register slash commands: %v", err)
	}
}

func onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i.Type != discordgo.InteractionApplicationCommand {
		return
	}

	data := i.ApplicationCommandData()
	if i.GuildID == "" || i.Member == nil {
		return
	}

	respond := func(content string, flags discordgo.MessageFlags) {
		if err := s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
			Type: discordgo.InteractionResponseChannelMessageWithSource,
			Data: &discordgo.InteractionResponseData{
				Content: content,
				Flags:   flags,
			},
		}); err != nil {
			log.Printf("Failed to respond to interaction: %v", err)
		}
	}

	if data.Name != "honeypot-set" {
		respond("Unknown command", discordgo.MessageFlagsEphemeral)
		return
	}

	if i.Member.Permissions&requiredPermissions != requiredPermissions {
		respond("You don't have permission to use this command.", discordgo.MessageFlagsEphemeral)
		return
	}

	channelID := optionString(data.Options, "channel")
	action := optionString(data.Options, "action")
	logChannelID := optionString(data.Options, "log_channel")

	if action == "disabled" {
		if _, err := db.Exec(`DELETE FROM honeypots WHERE guild_id = ?`, i.GuildID); err != nil {
			log.Printf("Failed to delete honeypot config: %v", err)
		}
		respond("Honeypot configuration updated: Disabled honeypot for this server.", 0)
		return
	}

	var logChannel any
	if logChannelID != "" {
		logChannel = logChannelID
	}

	if _, err := db.Exec(`
		INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(guild_id) DO UPDATE SET
			channel_id = excluded.channel_id,
			action = excluded.action,
			log_channel_id = excluded.log_channel_id
	`, i.GuildID, channelID, action, logChannel); err != nil {
		log.Printf("Failed to update honeypot config: %v", err)
	}

	content := fmt.Sprintf("Honeypot configuration updated: Will **%s** anyone who types in <#%s>", action, channelID)
	if logChannelID != "" {
		content += fmt.Sprintf(" and log actions to <#%s>", logChannelID)
	} else {
		content += " and won't log actions"
	}
	content += "."

	respond(content, 0)
}

func onMessageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	if m.Author.Bot || m.GuildID == "" {
		return
	}

	var channelID, action string
	var logChannelID sql.NullString
	err := db.QueryRow(`SELECT channel_id, action, log_channel_id FROM honeypots WHERE guild_id = ?`, m.GuildID).Scan(&channelID, &action, &logChannelID)
	if errors.Is(err, sql.ErrNoRows) {
		return
	}
	if err != nil {
		log.Printf("Failed to look up honeypot config: %v", err)
		return
	}

	if channelID != m.ChannelID {
		return
	}

	success := true
	if action == "ban" {
		// discordgo's ban API only accepts delete_message_days (0-7), so 3600s -> 1 day.
		if err := s.GuildBanCreateWithReason(m.GuildID, m.Author.ID, "User typed in #honeypot channel -> ban", 1); err != nil {
			success = false
			log.Printf("Failed honeypot action (%s): %v", action, err)
		}
	} else if action == "softban" {
		if err := s.GuildBanCreateWithReason(m.GuildID, m.Author.ID, "User typed in #honeypot channel -> softban (1/2)", 1); err != nil {
			success = false
			log.Printf("Failed honeypot action (%s): %v", action, err)
		} else if err := s.GuildBanDelete(m.GuildID, m.Author.ID, discordgo.WithAuditLogReason("User typed in #honeypot channel -> softban (2/2)")); err != nil {
			success = false
			log.Printf("Failed honeypot action (%s): %v", action, err)
		}
	} else {
		success = false
		log.Printf("Failed honeypot action (%s): Unknown honeypot action: %s", action, action)
	}

	targetChannelID := logChannelID.String
	if !success && targetChannelID == "" {
		targetChannelID = m.ChannelID
	}
	if targetChannelID == "" {
		return
	}

	content := fmt.Sprintf("User <@%s> was %s for triggering the honeypot in <#%s>", m.Author.ID, action, m.ChannelID)
	if !success {
		content = fmt.Sprintf("User <@%s> triggered the honeypot but I **failed** to %s them, please check my permissions to ensure I can %s them.", m.Author.ID, action, action)
	}

	if _, err := s.ChannelMessageSendComplex(targetChannelID, &discordgo.MessageSend{
		Content:         content,
		AllowedMentions: &discordgo.MessageAllowedMentions{},
	}); err != nil {
		log.Printf("Failed to send honeypot log message: %v", err)
	}
}

func onChannelDelete(s *discordgo.Session, c *discordgo.ChannelDelete) {
	if _, err := db.Exec(`DELETE FROM honeypots WHERE channel_id = ?`, c.ID); err != nil {
		log.Printf("Failed to delete honeypot config: %v", err)
	}
}

func onGuildDelete(s *discordgo.Session, g *discordgo.GuildDelete) {
	if _, err := db.Exec(`DELETE FROM honeypots WHERE guild_id = ?`, g.ID); err != nil {
		log.Printf("Failed to delete honeypot config: %v", err)
	}
}

func optionString(options []*discordgo.ApplicationCommandInteractionDataOption, name string) string {
	for _, opt := range options {
		if opt.Name == name {
			if v, ok := opt.Value.(string); ok {
				return v
			}
		}
	}
	return ""
}
