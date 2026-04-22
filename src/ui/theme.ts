// Palette mirrors the leaked claude-code dark theme (src/utils/theme.ts).
// Hex instead of rgb() so chalk (used by ink) parses it directly.
export const theme = {
  border: '#b1b9f9' as const, // suggestion — light blue-purple
  running: '#93a5ff' as const, // claudeBlue — system spinner blue
  done: '#4eba65' as const, // success
  error: '#ff6b80' as const, // error
  dim: '#999999' as const, // inactive — matches <Text dimColor> look
  accent: '#b1b9f9' as const, // suggestion
  thinking: '#ffc107' as const, // warning — amber
  text: '#ffffff' as const, // text — white
};

export const glyph = {
  pending: '○',
  done: '✓',
  error: '✗',
  arrow: '▸',
  thinking: '\u{1F4AD}', // 💭
  // Platform-aware bullet: ⏺ aligns vertically on darwin, ● is a safer
  // fallback elsewhere (matches leaked claude-code behavior).
  bullet: process.platform === 'darwin' ? '⏺' : '●',
  result: '⎿',
};
