export type ValueID = number
export type BlockID = number
export type FunctionID = number
// Identity of one lowered operation. Dense, program-scoped, assigned in lowering order;
// indexes ProgramIR.sites. Requirement and outcome records reference operations by SiteID
// (integer equality, array indexing), never by comparing spans or message strings.
export type SiteID = number
// Index into ProgramIR.moduleBindings and SharedState.modules. Dense, assigned by the
// whole-file scan in declaration order.
export type ModuleBindingID = number
