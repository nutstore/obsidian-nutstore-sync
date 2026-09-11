import { Setting } from 'obsidian'
import type { SkillDiagnostic, SkillMetadata } from '~/ai/skills/types'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

export default class SkillsSettingsSection extends BaseSettings {
	readonly name = () => i18n.t('settings.ai.skills.heading')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.ai.skills.heading'),
			i18n.t('settings.ai.skills.empty'),
			i18n.t('settings.ai.skills.diagnostics.heading'),
		]
	}

	async display() {
		this.containerEl.empty()
		const { skills, diagnostics } =
			await this.plugin.chatService.listConfigurableSkills()
		const disabled = new Set(this.plugin.settings.ai.disabledSkills)

		if (skills.length === 0) {
			new Setting(this.containerEl).setDesc(i18n.t('settings.ai.skills.empty'))
		} else {
			for (const skill of skills) this.renderSkill(skill, disabled)
		}
		this.renderDiagnostics(diagnostics)
	}

	private renderSkill(skill: SkillMetadata, disabled: ReadonlySet<string>) {
		new Setting(this.containerEl)
			.setName(skill.name)
			.setDesc(skill.description)
			.addToggle((toggle) =>
				toggle
					.setValue(!disabled.has(skill.name))
					.setTooltip(i18n.t('settings.ai.skills.enabled'))
					.onChange(async (enabled) => {
						const disabledSkills = new Set(
							this.plugin.settings.ai.disabledSkills,
						)
						if (enabled) {
							disabledSkills.delete(skill.name)
						} else {
							disabledSkills.add(skill.name)
						}
						this.plugin.settings.ai.disabledSkills = [...disabledSkills].sort()
						await this.plugin.settingsService.saveSettings()
					}),
			)
	}

	private renderDiagnostics(diagnostics: SkillDiagnostic[]) {
		if (diagnostics.length === 0) return
		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.skills.diagnostics.heading'))
			.setHeading()
		for (const diagnostic of diagnostics) {
			new Setting(this.containerEl)
				.setName(diagnostic.path)
				.setDesc(diagnostic.message)
		}
	}
}
