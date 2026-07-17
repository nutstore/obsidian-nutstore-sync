export interface SkillMetadata {
	name: string
	description: string
	path: string
}

export interface BuiltinSkill extends SkillMetadata {
	content: string
}

export interface SkillDiagnostic {
	path: string
	message: string
}
