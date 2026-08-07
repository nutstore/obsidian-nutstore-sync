export interface SkillMetadata {
	name: string
	description: string
	path: string
}

export interface BuiltinSkillResource {
	path: string
	content: string
}

export interface BuiltinSkill extends SkillMetadata {
	content: string
	resources?: readonly BuiltinSkillResource[]
}

export interface SkillDiagnostic {
	path: string
	message: string
}
