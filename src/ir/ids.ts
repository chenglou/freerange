export type ValueID = number
export type BlockID = number
export type FunctionID = number
// Index into ProjectIR.modules: one analyzed source file. Dense, assigned from the project's
// source order before any module lowers, so a call can name a module that has not lowered.
export type ModuleID = number
// A function named across modules: its module and its index in that module's functions.
export type FunctionRef = {module: ModuleID; function: FunctionID}
// Identity of one lowered operation. Dense, project-scoped, assigned in lowering order;
// indexes ProjectIR.sites. Requirement and outcome records reference operations by SiteID
// (integer equality, array indexing), never by comparing spans or message strings. A site
// adopted through an imported call keeps pointing at the callee module's operation.
export type SiteID = number
// Index into ProgramIR.moduleBindings and SharedState.modules. Dense, assigned by the
// whole-file scan in declaration order.
export type ModuleBindingID = number
