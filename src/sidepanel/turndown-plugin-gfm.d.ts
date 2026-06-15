// turndown-plugin-gfm ships no types. We only use `gfm` (the bundle of tables,
// strikethrough, task-list-items, and highlighted code).
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
}
