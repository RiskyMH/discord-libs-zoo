<?php

require __DIR__.'/vendor/autoload.php';

use Discord\Builders\CommandBuilder;
use Discord\Discord;
use Discord\Helpers\Collection;
use Discord\Parts\Channel\Channel;
use Discord\Parts\Channel\Message;
use Discord\Parts\Interactions\ApplicationCommand;
use Discord\Parts\Interactions\Command\Choice;
use Discord\Parts\Interactions\Command\Option;
use Discord\Parts\Interactions\Interaction;
use Discord\Parts\OAuth\Application;
use Discord\Parts\Permissions\Permission;
use Discord\Parts\User\Activity;
use Discord\WebSockets\Event;
use Discord\WebSockets\Intents;

use function Discord\promiseFromGenerator;

$token = getenv('DISCORD_TOKEN');
if (! $token) {
    fwrite(STDERR, "DISCORD_TOKEN is required\n");
    exit(1);
}

// Guild honeypot config is stored in SQLite so it survives restarts.
$pdo = new PDO('sqlite:'.(getenv('DB_PATH') ?: 'bot.db'));
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec(
    "CREATE TABLE IF NOT EXISTS honeypots (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'ban',
        log_channel_id TEXT
    )"
);

$formatError = static fn ($error) => $error instanceof Throwable ? $error->getMessage() : (string) $error;

$discord = new Discord([
    'token' => $token,
    // Guilds + guild messages are the only intents the honeypot needs.
    'intents' => [Intents::GUILDS, Intents::GUILD_MESSAGES],
]);

$discord->on('init', function (Discord $discord) use ($formatError) {
    echo 'Logged in as '.$discord->user->username.'#'.$discord->user->discriminator."\n";

    $discord->updatePresence(
        $discord->factory(Activity::class, [
            'name' => '#honeypot',
            'state' => 'Watching #honeypot for bots',
            'type' => Activity::TYPE_CUSTOM,
        ])
    );

    // Register slash commands once on startup.
    $channelOption = (new Option($discord))
        ->setType(Option::CHANNEL)
        ->setName('channel')
        ->setDescription('The channel to ban people that message in it')
        ->setRequired(true)
        ->setChannelTypes([Channel::TYPE_GUILD_TEXT]);

    $actionOption = (new Option($discord))
        ->setType(Option::STRING)
        ->setName('action')
        ->setDescription('The action to take when someone messages in the honeypot channel')
        ->setRequired(true)
        ->addChoices([
            new Choice($discord, ['name' => 'Ban', 'value' => 'ban']),
            new Choice($discord, ['name' => 'Softban', 'value' => 'softban']),
            new Choice($discord, ['name' => 'Disabled', 'value' => 'disabled']),
        ]);

    $logChannelOption = (new Option($discord))
        ->setType(Option::CHANNEL)
        ->setName('log_channel')
        ->setDescription("The channel to log actions in (if ommited, then it won't log anywhere)")
        ->setRequired(false)
        ->setChannelTypes([Channel::TYPE_GUILD_TEXT, Channel::TYPE_PUBLIC_THREAD, Channel::TYPE_PRIVATE_THREAD]);

    // (note: DiscordPHP has no bulk-overwrite API, so commands are registered one at a time, sadly)
    $command = CommandBuilder::new()
        ->setName('honeypot-set')
        ->setDescription('Set/update honeypot channel (note: this overrides previous config set)')
        ->setDefaultMemberPermissions((1 << Permission::BAN_MEMBERS) | (1 << Permission::MANAGE_CHANNELS))
        ->setContext([Interaction::CONTEXT_TYPE_GUILD])
        ->addIntegrationType(Application::INTEGRATION_TYPE_GUILD_INSTALL)
        ->addOption($channelOption)
        ->addOption($actionOption)
        ->addOption($logChannelOption)
        ->create($discord->application->commands);

    $command->save()->then(null, function ($error) use ($formatError) {
        fwrite(STDERR, 'Failed to register slash commands: '.$formatError($error)."\n");
    });
});

// Handle the /honeypot-set command.
$discord->listenCommand('honeypot-set', function (ApplicationCommand $interaction, Collection $params) use ($pdo) {
    $permissions = $interaction->member?->permissions;
    if (! $permissions || ! ($permissions->ban_members && $permissions->manage_channels)) {
        $interaction->respondWithMessage("You don't have permission to use this command.", true);
        return;
    }

    $channelId = $params->get('name', 'channel')?->value;
    $action = $params->get('name', 'action')?->value;
    $logChannelId = $params->get('name', 'log_channel')?->value;

    if ($action === 'disabled') {
        // "disabled" removes the config instead of updating it.
        $stmt = $pdo->prepare('DELETE FROM honeypots WHERE guild_id = ?');
        $stmt->execute([$interaction->guild_id]);

        $interaction->respondWithMessage('Honeypot configuration updated: Disabled honeypot for this server.');
        return;
    }

    $stmt = $pdo->prepare(
        'INSERT INTO honeypots (guild_id, channel_id, action, log_channel_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
             channel_id = excluded.channel_id,
             action = excluded.action,
             log_channel_id = excluded.log_channel_id'
    );
    $stmt->execute([$interaction->guild_id, $channelId, $action, $logChannelId]);

    $interaction->respondWithMessage(sprintf(
        'Honeypot configuration updated: Will **%s** anyone who types in <#%s> %s.',
        $action,
        $channelId,
        $logChannelId ? "and log actions to <#$logChannelId>" : "and won't log actions"
    ));
});

// Ban anyone who messages in the configured honeypot channel.
$discord->on(Event::MESSAGE_CREATE, function (Message $message) use ($pdo, $formatError) {
    if (! $message->guild_id || $message->author?->bot) {
        return;
    }

    $stmt = $pdo->prepare('SELECT * FROM honeypots WHERE guild_id = ?');
    $stmt->execute([$message->guild_id]);
    $honeypot = $stmt->fetch(PDO::FETCH_ASSOC);

    if (! $honeypot || $honeypot['channel_id'] !== $message->channel_id) {
        return;
    }

    $guild = $message->guild;
    $userId = $message->author->id;
    $action = $honeypot['action'];

    $performAction = function () use ($guild, $userId, $action) {
        if ($action === 'ban') {
            return $guild->bans->ban($userId, [
                'delete_message_seconds' => 3600, // 1hr
            ], 'User typed in #honeypot channel -> ban');
        }

        if ($action === 'softban') {
            return promiseFromGenerator((function () use ($guild, $userId) {
                yield $guild->bans->ban($userId, [
                    'delete_message_seconds' => 3600, // 1hr
                ], 'User typed in #honeypot channel -> softban (1/2)');
                yield $guild->bans->unban($userId, 'User typed in #honeypot channel -> softban (2/2)');
            })());
        }

        throw new \Exception("Unknown honeypot action: {$action}");
    };

    $sendLog = function (bool $success) use ($message, $honeypot, $guild, $formatError) {
        // On failure, log to the honeypot channel itself so moderators still see it.
        $targetChannelId = $success
            ? $honeypot['log_channel_id']
            : ($honeypot['log_channel_id'] ?: $message->channel_id);
        if (! $targetChannelId) {
            return;
        }

        $content = $success
            ? "User <@{$message->author->id}> was {$honeypot['action']} for triggering the honeypot in <#{$message->channel_id}>"
            : "User <@{$message->author->id}> triggered the honeypot but I **failed** to {$honeypot['action']} them, please check my permissions to ensure I can {$honeypot['action']} them.";

        if (! $guild) {
            return;
        }

        $guild->channels->fetch($targetChannelId)->then(
            function ($channel) use ($content, $formatError) {
                if (! $channel->isTextBased()) {
                    return;
                }

                $channel->sendMessage($content, false, null, ['parse' => []])->then(null, function ($error) use ($formatError) {
                    fwrite(STDERR, 'Failed to send honeypot log message: '.$formatError($error)."\n");
                });
            },
            function ($error) use ($formatError) {
                fwrite(STDERR, 'Failed to send honeypot log message: '.$formatError($error)."\n");
            }
        );
    };

    try {
        $performAction()->then(
            function () use ($sendLog) {
                $sendLog(true);
            },
            function ($error) use ($sendLog, $formatError, $action) {
                fwrite(STDERR, "Failed honeypot action ({$action}): ".$formatError($error)."\n");
                $sendLog(false);
            }
        );
    } catch (\Throwable $error) {
        fwrite(STDERR, "Failed honeypot action ({$action}): ".$formatError($error)."\n");
        $sendLog(false);
    }
});

// Clean up config when a channel or guild goes away.
$discord->on(Event::CHANNEL_DELETE, function ($channel) use ($pdo) {
    $stmt = $pdo->prepare('DELETE FROM honeypots WHERE channel_id = ?');
    $stmt->execute([$channel->id]);
});

$discord->on(Event::GUILD_DELETE, function ($guild) use ($pdo) {
    $stmt = $pdo->prepare('DELETE FROM honeypots WHERE guild_id = ?');
    $stmt->execute([$guild->id ?? $guild->guild_id]);
});

$discord->run();
