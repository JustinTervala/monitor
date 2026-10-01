import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchMatcher } from '../src/renderer/search';

test('search tolerates missing, extra, substituted, and swapped letters', () => {
  for (const query of ['billng', 'billling', 'billong', 'billign', 'bililng'])
    assert.equal(createSearchMatcher(query)('Build the billing rollout'), true, query);
  assert.equal(createSearchMatcher('historiacl')('Historical task 259'), true);
  assert.equal(createSearchMatcher('historkcal')('Historical task 259'), true);
  assert.equal(createSearchMatcher('hstorkcal')('Historical task 259'), true);
  assert.equal(createSearchMatcher('blng')('Build the billing rollout'), false);
});

test('search combines words in any order across names, projects, and paths', () => {
  const text =
    'Billing rollout Review authentication payments /Users/justin/work/payments ~/work/payments';
  for (const query of [
    'rollout billng',
    'paymnts review',
    'auth billng',
    '~/wokr/paymnts',
    '/Users/justin/work/payments',
    '  REVIEW   billign  ',
  ])
    assert.equal(createSearchMatcher(query)(text), true, query);
  for (const query of ['billing playback', 'review media', 'no-matching-workstream'])
    assert.equal(createSearchMatcher(query)(text), false, query);
});

test('short terms and numbered identifiers do not acquire fuzzy near-matches', () => {
  assert.equal(createSearchMatcher('gti')('git'), false);
  assert.equal(createSearchMatcher('api')('app'), false);
  assert.equal(createSearchMatcher('historiacl task 259')('Historical task 259'), true);
  assert.equal(createSearchMatcher('historiacl task 259')('Historical task 258'), false);
  assert.equal(createSearchMatcher('build1234')('build1235'), false);
  assert.equal(createSearchMatcher('build')('build2'), true);
  assert.equal(createSearchMatcher('buidl')('build2'), false);
});

test('literal fragments, accents, case, whitespace, and punctuation stay useful', () => {
  assert.equal(createSearchMatcher('')('Anything'), true);
  assert.equal(createSearchMatcher('  \t ')('Anything'), true);
  assert.equal(createSearchMatcher('bill')('Billing rollout'), true);
  assert.equal(createSearchMatcher('deploy-cafe')('Déploy Café'), true);
  assert.equal(createSearchMatcher('DÉPLOY')('deploy'), true);
  assert.equal(createSearchMatcher('登录')('修复登录流程'), true);
  assert.equal(createSearchMatcher('~')('~/work/payments'), true);
  assert.equal(createSearchMatcher('~')('/work/payments'), false);
  assert.equal(createSearchMatcher('---')('Billing rollout'), false);
});

test('fuzzy filtering retains the existing order and requires every query word', () => {
  const entries = ['Billing rollout', 'Billng investigation', 'Playback fix'];
  assert.deepEqual(entries.filter(createSearchMatcher('billng')), entries.slice(0, 2));
  assert.deepEqual(entries.filter(createSearchMatcher('billng roollout')), [entries[0]]);
  assert.deepEqual(entries.filter(createSearchMatcher('billng nonexistent')), []);
});
