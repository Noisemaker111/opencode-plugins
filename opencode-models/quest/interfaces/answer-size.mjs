export const ANSWER_PAGE_CHARACTERS = 1000
export const ANSWER_ROW_CHARACTERS = 150

export const COMPACT_QUEST_OPERATIONS = ['list', 'get', 'inspect', 'status', 'history', 'routing', 'routingHistory', 'roles', 'waterfall', 'report', 'system_state']

export const SYSTEM_STATE_SECTIONS = ['board', 'runs', 'hosts', 'serving', 'reloadQueue', 'accounts', 'blockedSteps', 'needsYou', 'routes', 'diagnostics']

export const FULL_INPUT = { type: 'boolean', description: 'Only for a person debugging at the terminal (quest --full): the whole stored record. Every answer is otherwise a page of about ' + ANSWER_PAGE_CHARACTERS.toLocaleString('en-US') + ' characters, one row of about ' + ANSWER_ROW_CHARACTERS + ' characters per item; a caller that needs more asks for that one piece by its section, view or filter.' }
