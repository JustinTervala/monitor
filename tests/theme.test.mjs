import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
const colors = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1], match[2]]),
);
function luminance(hex) {
  const linear = hex
    .slice(1)
    .match(/../g)
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function requireContrast(foreground, background, minimum) {
  assert.ok(colors[foreground], `Missing ${foreground} color`);
  assert.ok(colors[background], `Missing ${background} color`);
  const values = [luminance(colors[foreground]), luminance(colors[background])];
  const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  assert.ok(
    ratio >= minimum,
    `${foreground} on ${background}: ${ratio.toFixed(2)}:1, requires ${minimum}:1`,
  );
}

// WCAG contrast thresholds for normal text (4.5:1) and non-text indicators (3:1).
// These check palette pairs, not full application accessibility conformance.
const surfaces = ['background', 'surface', 'panel', 'hover', 'selected'];
test('Midnight text retains contrast on normal, hovered, and selected surfaces', () => {
  for (const background of surfaces)
    for (const foreground of ['foreground', 'muted', 'accent'])
      requireContrast(foreground, background, 4.5);
  for (const background of ['button-primary', 'button-primary-hover'])
    requireContrast('button-primary-text', background, 4.5);
  for (const background of ['button-tint', 'button-tint-hover'])
    requireContrast('accent', background, 4.5);
  requireContrast('error-text', 'error-surface', 4.5);
});

test('status markers and focus remain distinct from dark and selected backgrounds', () => {
  for (const background of surfaces)
    for (const foreground of [
      'status-review',
      'status-running',
      'status-read',
      'status-unknown',
      'status-snoozed',
      'accent',
      'control-border',
    ])
      requireContrast(foreground, background, 3);
});
