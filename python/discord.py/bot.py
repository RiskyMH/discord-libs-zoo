from __future__ import annotations

import os
import sqlite3
import sys
from typing import Optional

import discord
from discord import app_commands

TOKEN = os.environ.get("DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN is required")

DB_PATH = os.environ.get("DB_PATH", "bot.db")


class ChannelTransformer(app_commands.Transformer):
    def __init__(self, *types: discord.ChannelType) -> None:
        self._types = list(types)

    @property
    def type(self) -> discord.AppCommandOptionType:
        return discord.AppCommandOptionType.channel

    @property
    def channel_types(self) -> list[discord.ChannelType]:
        return self._types

    async def transform(self, interaction: discord.Interaction, value, /):
        return value


class HoneypotClient(discord.Client):
    def __init__(self) -> None:
        super().__init__(
            intents=discord.Intents(guilds=True, messages=True),
            activity=discord.CustomActivity(name="Watching #honeypot for bots"),
            status=discord.Status.online,
        )
        self.tree = app_commands.CommandTree(self)

        self.db = sqlite3.connect(DB_PATH)
        self.db.row_factory = sqlite3.Row
        self.db.execute(
            """
            CREATE TABLE IF NOT EXISTS honeypots (
                guild_id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                action TEXT NOT NULL DEFAULT 'ban',
                log_channel_id TEXT
            )
            """
        )
        self.db.commit()

        self._register_commands()

    def _register_commands(self) -> None:
        @self.tree.command(
            name="honeypot-set",
            description="Set/update honeypot channel (note: this overrides previous config set)",
        )
        @app_commands.describe(
            channel="The channel to ban people that message in it",
            action="The action to take when someone messages in the honeypot channel",
            log_channel="The channel to log actions in (if ommited, then it won't log anywhere)",
        )
        @app_commands.choices(
            action=[
                app_commands.Choice(name="Ban", value="ban"),
                app_commands.Choice(name="Softban", value="softban"),
                app_commands.Choice(name="Disabled", value="disabled"),
            ]
        )
        @app_commands.guild_only()
        @app_commands.guild_install()
        @app_commands.default_permissions(ban_members=True, manage_channels=True)
        async def honeypot_set(
            interaction: discord.Interaction,
            channel: app_commands.Transform[
                discord.TextChannel,
                ChannelTransformer(discord.ChannelType.text),
            ],
            action: str,
            log_channel: Optional[
                app_commands.Transform[
                    discord.TextChannel,
                    ChannelTransformer(
                        discord.ChannelType.text,
                        discord.ChannelType.public_thread,
                        discord.ChannelType.private_thread,
                    ),
                ]
            ] = None,
        ) -> None:
            permissions = interaction.user.guild_permissions
            if not (permissions.ban_members and permissions.manage_channels):
                await interaction.response.send_message(
                    "You don't have permission to use this command.", ephemeral=True
                )
                return

            if action == "disabled":
                self.db.execute(
                    "DELETE FROM honeypots WHERE guild_id = ?",
                    (str(interaction.guild_id),),
                )
                self.db.commit()
                await interaction.response.send_message(
                    "Honeypot configuration updated: Disabled honeypot for this server."
                )
                return

            self.db.execute(
                """
                INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                    channel_id = excluded.channel_id,
                    action = excluded.action,
                    log_channel_id = excluded.log_channel_id
                """,
                (
                    str(interaction.guild_id),
                    str(channel.id),
                    action,
                    str(log_channel.id) if log_channel else None,
                ),
            )
            self.db.commit()

            log_suffix = (
                f"and log actions to <#{log_channel.id}>"
                if log_channel
                else "and won't log actions"
            )
            await interaction.response.send_message(
                f"Honeypot configuration updated: Will **{action}** anyone who types in "
                f"<#{channel.id}> {log_suffix}."
            )

    async def on_ready(self) -> None:
        print(f"Logged in as {self.user}", flush=True)
        await self.tree.sync()

    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or not message.guild:
            return

        row = self.db.execute(
            "SELECT * FROM honeypots WHERE guild_id = ?", (str(message.guild.id),)
        ).fetchone()
        if row is None or row["channel_id"] != str(message.channel.id):
            return

        action = row["action"]
        success = True
        try:
            if action == "ban":
                await message.author.ban(
                    delete_message_seconds=3600,
                    reason="User typed in #honeypot channel -> ban",
                )
            elif action == "softban":
                await message.author.ban(
                    delete_message_seconds=3600,
                    reason="User typed in #honeypot channel -> softban (1/2)",
                )
                await message.guild.unban(
                    message.author.id,
                    reason="User typed in #honeypot channel -> softban (2/2)",
                )
            else:
                raise RuntimeError(f"Unknown honeypot action: {action}")
        except Exception as error:
            success = False
            print(f"Failed honeypot action ({action}): {error}", file=sys.stderr)

        target_channel_id = (
            row["log_channel_id"]
            if success
            else row["log_channel_id"] or str(message.channel.id)
        )
        if target_channel_id is None:
            return

        target_channel = await message.guild.fetch_channel(int(target_channel_id))
        if not isinstance(target_channel, discord.abc.Messageable):
            return

        try:
            await target_channel.send(
                content=(
                    f"User <@{message.author.id}> was {action} for triggering the honeypot "
                    f"in <#{message.channel.id}>"
                    if success
                    else f"User <@{message.author.id}> triggered the honeypot but I "
                    f"**failed** to {action} them, please check my permissions to "
                    f"ensure I can {action} them."
                ),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception as error:
            print(f"Failed to send honeypot log message: {error}", file=sys.stderr)

    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        self.db.execute(
            "DELETE FROM honeypots WHERE channel_id = ?", (str(channel.id),)
        )
        self.db.commit()

    async def on_guild_remove(self, guild: discord.Guild) -> None:
        self.db.execute(
            "DELETE FROM honeypots WHERE guild_id = ?", (str(guild.id),)
        )
        self.db.commit()


def main() -> None:
    client = HoneypotClient()
    client.run(TOKEN)


if __name__ == "__main__":
    main()
