// Require the necessary discord.js classes
import { REST } from '@discordjs/rest'
import AdmZip from 'adm-zip'
import { RESTPatchAPIApplicationCommandJSONBody, Routes } from 'discord-api-types/v9'
import { AnyChannel, Client, CommandInteraction, ExcludeEnum, Guild, GuildMember, Intents, Interaction, Message, MessageActionRow, MessageButton, MessageOptions, TextBasedChannel, TextChannel } from 'discord.js'
import { https } from 'follow-redirects'
import { Constants } from './constants'
import { LocalCommandManager } from './managers/commandManager'
import { LiveCommandManager } from './managers/liveCommandManager'
import fs from 'fs'
import fsp from 'fs/promises'
import { LocalInteractionManager } from './managers/interactionManager'
import { LiveInteractionManager } from './managers/liveInteractionManager'
import yaml from 'js-yaml'
import path from 'path'
import { constantsFromObject, hasPermission, loadYaml } from './utils'
import { ChannelId, LiveConfig } from './models/LiveConfig'
import { MessageLiveInteraction } from './models/MessageLiveInteraction'
import { LiveTriggerManager } from './managers/triggerManager'
import { IAutocompletableCommand, IExecutableCommand } from './commands/command'
import { ModMailManager } from './managers/modMailManager'
import { ReactRolesManager } from './managers/reactRolesManager'
import { VanityRolesManager } from './managers/vanityRolesManager'
import { DatabaseManager } from './managers/databaseManager'
import { PointsManager } from './managers/pointsManager'
import { ActivityTypes } from 'discord.js/typings/enums'
import { ModerationModuleManager } from './managers/moderationModuleManager'

class DiscordBotHandler {
    client = new Client({
        intents: [
            Intents.FLAGS.GUILDS,
            Intents.FLAGS.GUILD_MESSAGES,
            Intents.FLAGS.GUILD_MEMBERS,
            Intents.FLAGS.DIRECT_MESSAGES,
            Intents.FLAGS.GUILD_MESSAGE_REACTIONS
        ],
        partials: [
            'MESSAGE',
            'CHANNEL',
            'REACTION'
        ],
        retryLimit: 2,
        restGlobalRateLimit: 50,
    })
    restClient = new REST({ version: '9' }).setToken(Constants.DISCORD_BOT_TOKEN)

    get guild(): Promise<Guild> {
        return (async () => {
            let guild: Guild | undefined

            if (this.client.guilds.cache.has(Constants.DISCORD_GUILD_ID))
                guild = this.client.guilds.cache.get(Constants.DISCORD_GUILD_ID)
            else
                guild = await this.client.guilds.fetch(Constants.DISCORD_GUILD_ID)
            
            if (!guild) {
                throw new Error(`Unable to resolve guild ${Constants.DISCORD_GUILD_ID}`)
            }

            return guild
        })()
    }


    localCommandManager = new LocalCommandManager()
    liveCommandManager = new LiveCommandManager()

    localInteractionManager = new LocalInteractionManager()
    liveInteractionManager = new LiveInteractionManager()
    liveTriggerManager = new LiveTriggerManager()
    modMailManager = new ModMailManager()
    reactRolesManager = new ReactRolesManager()
    vanityRolesManager = new VanityRolesManager()
    databaseManager = new DatabaseManager()
    pointsManager = new PointsManager()
    moderationManager = new ModerationModuleManager()

    liveConstants: any | undefined = {}
    liveConfig: LiveConfig = {}

    constructor() {
        console.log('Initialized a new Bot Handler')
    }

    async initialize() {
        try {
            await this.loadCommands()

            // When the client is ready, run this code (only once)
            this.client.once('ready', () => {
                console.log('Ready!')
            })

            this.client.on('threadUpdate', async (oldThread, newThread) => {
                if (oldThread.partial) { oldThread = await oldThread.fetch() }
                if (newThread.parent) { newThread = await newThread.fetch() }

                const autoArchiveDuration: string | number | null = oldThread.autoArchiveDuration
                if (typeof autoArchiveDuration === 'string' || !autoArchiveDuration) { return }
                
                if (oldThread.archived || autoArchiveDuration > 144 || oldThread.type == 'GUILD_PRIVATE_THREAD') { return }
                if (!newThread.archived) { return }

                try {
                    const starterMessage = await newThread.fetchStarterMessage()
                    await starterMessage.delete()
                } catch (error) {
                    console.log(error)
                }
            })

            this.client.on('guildMemberRemove', async (member) => {
                try {
                    if (member.partial) {
                        member = await member.fetch()
                    }
                    
                    await this.vanityRolesManager.memberUpdated(member)
                } catch (err) {
                    this.logInternalError(err)
                }
            })

            this.client.on('guildMemberUpdate', async (_, member) => {
                try {
                    if (member.partial) {
                        member = await member.fetch()
                    }
                    
                    await this.vanityRolesManager.memberUpdated(member)
                } catch (err) {
                    this.logInternalError(err)
                }
            })

            this.client.on('guildMemberAvailable', async (member) => {
                try {
                    if (member.partial) {
                        member = await member.fetch()
                    }
                    
                    await this.vanityRolesManager.memberUpdated(member)
                } catch (err) {
                    this.logInternalError(err)
                }
            })

            this.client.on('guildMemberAdd', async (member) => {
                const welcomeChannelId = this.liveConfig.modules?.verification?.welcomeChannel
                if (welcomeChannelId) {
                    const channel = this.client.channels.cache.get(welcomeChannelId)
                    if (channel && channel.isText())
                        await this.sendWelcomeMessage(channel, member)
                }
            })

            this.client.on('messageReactionAdd', async (reaction, user) => {
                try {
                    console.log('message reaction add')
                    await this.reactRolesManager.handleReaction(reaction, user)
                } catch (err) {
                    this.logInternalError(err, reaction.message)
                }
            })

            this.client.on('messageCreate', async message => {
                try {
                    console.log('messageCreate')
                    await this.moderationManager.parseMessage(message)
                    await this.modMailManager.handleMessage(message)
                    await this.liveTriggerManager.parseMessage(message)
                    
                    if (!message.channel.isThread()) { return }
                    if (message.member?.user.bot) { return }
                    if (message.channel.autoArchiveDuration != 60) { return }
                    if (Constants.SUPPORT_CHANNEL_ID != message.channel.parentId) { return }
                    
                    await message.channel.send({ content: 'Setting archive duration to **24** hours due to activity' })
                    await message.channel.setAutoArchiveDuration(1440)
                } catch (err) {
                    this.logInternalError(err, message)
                }
            })

            this.client.on('interactionCreate', async interaction => {
                console.log('Interaction Created')
                try {
                    if (interaction.isCommand() || interaction.isAutocomplete()) {
                        const commandName = path.join(interaction.commandName, interaction.options.getSubcommand(false) ?? '')
                        const commandPerms = this.liveConfig.permissions?.[commandName]
                        if (commandPerms) {
                            if (!hasPermission(commandPerms, interaction.member as GuildMember)) {
                                if (interaction.isCommand())
                                    await interaction.reply({ content: 'You don\'t have permission to execute this command', ephemeral: true })
                                return
                            }
                        }

                        const CommandClass =
                            this.localCommandManager.resolveLocalCommandClass(interaction.commandName) ??
                            this.liveCommandManager.resolveLiveCommandClass(interaction.commandName, interaction.options.getSubcommand(false) ?? undefined)
                        if (!CommandClass) return

                        const commandInstance: IExecutableCommand | IAutocompletableCommand = new CommandClass()

                        if (interaction.isCommand() && (commandInstance as IExecutableCommand).execute)
                            await (commandInstance as IExecutableCommand).execute(interaction)
                        else if (interaction.isAutocomplete() && (commandInstance as IAutocompletableCommand).handleAutocomplete)
                            await (commandInstance as IAutocompletableCommand).handleAutocomplete(interaction)
                    } else if (interaction.isButton() || interaction.isSelectMenu()) {
                        const ExecutableInteractionClass = this.localInteractionManager.resolveInteraction(interaction.customId)
                        if (!ExecutableInteractionClass) return

                        const executableInteractionInstance = new ExecutableInteractionClass()
                        await executableInteractionInstance.execute(interaction)
                    }
                } catch (error) {
                    if (!interaction.isCommand() && !interaction.isSelectMenu() && !interaction.isMessageComponent()) {
                        await this.logInternalError(error)
                        return
                    }

                    console.error(error)
                    if (interaction.replied || interaction.deferred) {
                        await interaction.editReply({ content: '**ERROR**: ' + error })
                    } else {
                        await interaction.reply({content: `**ERROR:** ${error}`, ephemeral: true})
                    }
                }
            })

            this.client.on('error', async error => {
                await this.logInternalError(error)
            })

            // Login to Discord with your client's token
            await this.client.login(Constants.DISCORD_BOT_TOKEN)

            await this.loadActivity()
        } catch (error: any) {
            console.log('interal error')
            await this.client.login(Constants.DISCORD_BOT_TOKEN)
            await this.logInternalError(error)
            this.client.destroy()
        }
    }

    async loadActivity() {
        const activity = await this.databaseManager.getBotSettingsDocument().get('activity')
        if (!activity) return

        this.setActivity(activity.message, activity.type)
    }

    async setActivity(message: string, type: ExcludeEnum<typeof ActivityTypes, 'CUSTOM'>) {
        await this.client.user?.setActivity({
            name: message,
            type: type as number
        })

        await this.databaseManager.getBotSettingsDocument().set('activity', { message, type: type })
    }

    async removeActivity() {
        await this.client.user?.setActivity(undefined)
        await this.databaseManager.getBotSettingsDocument().set('activity', undefined)
    }

    async logInternalError(error: any, message: {url?: string} | undefined = undefined) {
        console.log(error)

        const channelId = Constants.BOT_INTERNAL_LOG_CHANNEL
        if (!channelId) return
        
        let channel: AnyChannel | null | undefined = this.client.channels.cache.get(channelId)
        if (!channel) {
            channel = await this.client.channels.fetch(channelId)
        }

        if (!channel?.isText()) return

        await channel.send(`**INTERNAL UNHANDLED ERROR**${message?.url == undefined ? '' : '\nMESSAGE:' + message?.url}\n${error}`)
    }

    async loadCommands() {
        await this.downloadAndExtractLiveCommandRepo()
        this.loadConstants()
        this.loadConfig()

        this.liveTriggerManager.loadTriggers()

        return this.registerCommands([
            ...this.liveCommandManager.getLiveCommands(),
            ...await this.localCommandManager.getLocalCommands()
        ])
    }

    async unloadCommands() {
        return this.registerCommands([])
    }

    loadConstants() {
        this.liveConstants = {}

        const liveConstantsPath = path.join(
            Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR,
            Constants.LIVE_COMMANDS_REPO_BASE_FOLDER_NAME,
            'constants.yaml'
        )

        if (!fs.existsSync(liveConstantsPath)) {
            return
        }

        try {
            this.liveConstants = yaml.load(
                fs.readFileSync(liveConstantsPath).toString()
            ) ?? {}

            console.log(`loaded constants: ${JSON.stringify(this.liveConstants, null, 2)}`)
        } catch (error: any) {
            throw new Error('Unable to load constants\n'+error)
        }
    }

    loadConfig() {
        this.liveConfig = {}

        const liveConfigPath = path.join(
            Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR,
            Constants.LIVE_COMMANDS_REPO_BASE_FOLDER_NAME,
            'config.yaml'
        )

        if (!fs.existsSync(liveConfigPath)) {
            console.log('Live config dont exist')
            return
        }

        try {
            this.liveConfig = loadYaml(
                fs.readFileSync(liveConfigPath).toString(),
                this.liveConstants
            ) ?? {}

            console.log(`loaded config: ${JSON.stringify(this.liveConfig, null, 2)}`)
        } catch(error: any) {
            throw new Error('Unable to load config\n' + error)
        }
    }

    async registerCommands(commands: RESTPatchAPIApplicationCommandJSONBody[]) {
        const hashSet: Record<string, RESTPatchAPIApplicationCommandJSONBody> = {}
        for (const command of commands) {
            if (!command.name) continue
            hashSet[command.name] = command

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            console.log(`Registering Command: ${command.name}, AC ${command.autocomplete ?? false}`)
        }

        if (Constants.DEV_MODE) {
            await this.restClient.put(Routes.applicationGuildCommands(Constants.DISCORD_CLIENT_ID, Constants.DISCORD_DEV_GUILD_ID), { body: Object.values(hashSet) })
        } else {
            await this.restClient.put(Routes.applicationGuildCommands(Constants.DISCORD_CLIENT_ID, Constants.DISCORD_GUILD_ID), { body: Object.values(hashSet) })
        }
    }

    async downloadAndExtractLiveCommandRepo() {
        const downloadFilePath = Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR + '.zip'

        if (fs.existsSync(Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR))
            await fsp.rm(Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR, { recursive: true, force: true })

        if (fs.existsSync(downloadFilePath))
            await fsp.rm(downloadFilePath)

        console.log('deleted existing file')

        // Download the zip
        await this.download(Constants.LIVE_COMMANDS_REPO, downloadFilePath)

        console.log('downloaded file')

        const zip = new AdmZip(downloadFilePath)
        zip.extractAllTo(Constants.LIVE_COMMANDS_REPO_EXTRACT_DIR)
    }

    private async download(url: string, filePath: string) {
        const proto = https

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(filePath)
            let fileInfo: unknown = null

            const request = proto.get(url, response => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to get '${url}' (${response.statusCode})`))
                    return
                }

                fileInfo = {
                    mime: response.headers['content-type'],
                    size: parseInt(response.headers['content-length'] ?? '', 10),
                }

                response.pipe(file)
            })

            // The destination stream is ended by the time it's called
            file.on('finish', () => resolve(fileInfo))

            request.on('error', err => {
                fs.unlink(filePath, () => reject(err))
            })

            file.on('error', err => {
                fs.unlink(filePath, () => reject(err))
            })

            request.end()
        })
    }

    private async sendWelcomeMessage(channel: TextBasedChannel, member: GuildMember) {
        if (!discordBot.liveConfig.modules?.verification?.enabled) return

        const liveInteractionId = discordBot.liveConfig.modules?.verification?.interactions?.initialMessageInteractionPath
        if (!liveInteractionId) {
            await channel.send('**ERROR:** `interactions.initial_message` not set')
            return
        }
        
        const liveInteraction = discordBot.liveInteractionManager.resolveLiveInteraction(
            liveInteractionId,
            constantsFromObject(member)
        )
        if (!liveInteraction) {
            await channel.send('**ERROR:** Unable to parse live interaction for id ' + liveInteractionId)
            return
        }

        const message = new MessageLiveInteraction(liveInteraction)
        await channel.send(message.toMessage({
            components: [
                new MessageActionRow()
                    .addComponents(
                        new MessageButton()
                            .setCustomId('verificationInteraction')
                            .setLabel(discordBot.liveConfig.modules?.verification?.button?.title ?? 'Verify')
                            .setStyle(discordBot.liveConfig.modules?.verification?.button?.type ?? 'PRIMARY'),
                    )
                    
            ]
        }))
    }

    async sendToChannel(channelId: ChannelId, message: MessageOptions) {
        const guild = await discordBot.guild

        let channel = guild.channels.cache.get(channelId)
        if (!channel) channel = await guild.channels.fetch(channelId) ?? undefined
        
        if (!channel || !channel.isText()) {
            throw new Error('Channel is not TextBased')
        }

        await channel.send(message)
    }
}

export const discordBot = new DiscordBotHandler()
discordBot.initialize()