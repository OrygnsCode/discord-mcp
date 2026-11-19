// Text from a file someone may have edited by hand. On Windows that file can
// start with a byte order mark: PowerShell 5 writes one with
// Set-Content -Encoding UTF8, and Notepad offers "UTF-8 with BOM". JSON.parse
// refuses it, so a bots.json or an AI client's config saved that way would
// read as broken. Dropping it changes nothing else in the text.
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
