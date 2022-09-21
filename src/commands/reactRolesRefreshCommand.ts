import { SlashCommandBuilder } from '@discordjs/builders'
import { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types'
import { CommandInteraction, Emoji, Guild, GuildMember, Message, MessageActionRow, MessageButton } from 'discord.js'
import { discordBot } from '..'
import { LiveInteractionManager } from '../managers/liveInteractionManager'
import { ReactRolesConfig, ReactRolesModule, RoleKit, RoleKitsModule } from '../models/LiveConfig'
import { MessageLiveInteraction } from '../models/MessageLiveInteraction'
import { constantsFromObject, hasPermission } from '../utils'
import { Command } from './command'

export default class ReactRolesCommand implements Command {
    get moduleConfig(): ReactRolesModule | undefined {
        return discordBot.liveConfig.modules?.reactRoles
    }

    get configs(): Record<string, ReactRolesConfig> {
        return this.moduleConfig?.configs ?? {}
    }

    getCommandMetadata(): RESTPostAPIApplicationCommandsJSONBody {
        return new SlashCommandBuilder()
            .setName('reactrolesrefresh')
            .setDescription('Display a message with reactions to get roles')
            .addStringOption(builder => builder
                .setName('message_link')
                .setDescription('The message to refresh')
                .setRequired(true)
            )
            .setDefaultPermission(this.moduleConfig?.enabled ?? false)
            .toJSON()
    }

    async execute(interaction: CommandInteraction): Promise<void> {
        if (!hasPermission(this.moduleConfig?.permissions, interaction.member as GuildMember, 'MANAGE_ROLES')) {
            await interaction.reply({ content: 'You dont have permission to use this command', ephemeral: true })
            return
        }

        if (!interaction.guild) {
            await interaction.reply({ content: 'Command only works in a guild', ephemeral: true })
            return
        }

        await interaction.deferReply({ephemeral: true})

        const messageLink = interaction.options.getString('message_link', true)
        const [messageId, channelId] = messageLink.split('/').reverse()

        const channel = await interaction.guild.channels.fetch(channelId)
        if (!channel?.isText()) return

        const reactMessage = await channel.messages.fetch(messageId)

        const [interactionName, configId] = reactMessage.embeds[0].footer?.text.split('#') ?? []
        if (interactionName !== 'reactRolesManager') return

        const config = this.configs[configId]
        if (!config) {
            await interaction.editReply({
                content: `Config with the name ${configId} does not exist`
            })
            return
        }

        if (!reactMessage.editable) {
            await interaction.editReply({
                content: 'Message is not editable'
            })
            return
        }

        await reactMessage.reactions.removeAll()

        await reactMessage.edit({
            embeds: [{
                title: config.title ?? 'Reaction Roles',
                color: config.color,
                description: (config.description ?? '')
                    + '\n\n'
                    + Object.entries(config.reactions ?? {})
                        .map(([emojiId, config]) => {
                            return `${emojiId.includes(':') ? `<:${emojiId}>` : emojiId} : ${config.description ?? `<@&${config.role ?? '0'}>`}`
                        }).join('\n'),
                footer: {
                    text: `reactRolesManager#${configId}`
                },
                image: config.image ? {
                    url: config.image
                } : undefined,
                timestamp: new Date()
            }]
        })

        await Promise.all(Object.keys(config.reactions ?? {}).map(emoji => reactMessage.react(emoji)))

        await interaction.editReply({content: `Successfully refreshed the message: ${messageLink}`})
    }

}
