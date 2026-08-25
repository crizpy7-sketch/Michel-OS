/** Terminal rendering for the gauntlet. No dependencies, honours NO_COLOR. */

const enabled = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

export const GLYPH = {
  pass: c.green('✓'),
  fail: c.red('✗'),
  warn: c.yellow('!'),
  running: c.cyan('▸'),
  bullet: c.grey('·'),
};

export function rule(label = '', width = 76): string {
  if (!label) return c.grey('─'.repeat(width));
  const text = ` ${label} `;
  const left = 3;
  const right = Math.max(width - left - text.length, 0);
  return c.grey('─'.repeat(left)) + c.bold(text) + c.grey('─'.repeat(right));
}

export function banner(title: string, subtitle: string): string {
  return ['', c.bold(c.magenta(title)), c.grey(subtitle), rule(), ''].join('\n');
}

export function kv(stats: Record<string, string | number> | undefined): string {
  if (!stats || Object.keys(stats).length === 0) return '';
  return c.grey(
    Object.entries(stats)
      .map(([k, v]) => `${k}=${v}`)
      .join('  '),
  );
}

export function pad(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\u001b\[\d+m/g, '');
  return s + ' '.repeat(Math.max(width - visible.length, 0));
}

export function bar(passed: number, total: number, width = 24): string {
  if (total === 0) return c.grey('─'.repeat(width));
  const filled = Math.round((passed / total) * width);
  return c.green('█'.repeat(filled)) + c.grey('░'.repeat(width - filled));
}
