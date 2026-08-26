'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname, 'supabase', 'migrations', '20260826200000_open_play_demand_inclusion.sql',
);
const workflowPath = path.join(
  __dirname, '.github', 'workflows', 'apply-open-play-demand-inclusion.yml',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const profitV2 = fs.readFileSync(path.join(
  __dirname, 'supabase', 'migrations', '20260826180000_profit_learning_v2.sql',
), 'utf8');

test('only Open Play schedule types are classified as occupied demand', () => {
  assert.match(migration, /create or replace function public\.demand_schedule_hour_is_open_play/i);
  assert.match(migration, /in \('openplay', 'openplaysession'\)/i);
  assert.match(migration, /scheduled_open_play_slots as materialized/i);
  assert.match(migration, /from successful_booking_slots[\s\S]*union[\s\S]*from scheduled_open_play_slots/i);
  assert.match(migration, /not public\.demand_schedule_hour_is_unavailable[\s\S]*or public\.demand_schedule_hour_is_open_play/i);
  assert.doesNotMatch(migration, /alter table public\.bookings|update public\.bookings|delete from public\.bookings/i);
});

test('future Open Play remains unavailable to private-booking experiments', () => {
  assert.doesNotMatch(migration, /future_open_units[\s\S]*or public\.demand_schedule_hour_is_open_play/i);
  assert.doesNotMatch(migration, /candidate_dates[\s\S]*or public\.demand_schedule_hour_is_open_play/i);
  assert.match(migration, /Future Open Play hours remain unavailable to private-booking promotions/i);
});

test('the guarded production patch matches the checksum-locked V2 function source', () => {
  const oldBlocks = [...migration.matchAll(/old_[a-z_]+\s+text\s*:=\s*\$old\$([\s\S]*?)\$old\$/gi)]
    .map(match => match[1]);
  assert.equal(oldBlocks.length, 2);
  oldBlocks.forEach(block => assert.ok(profitV2.includes(block), 'guarded source block must match V2'));
  assert.match(migration, /definition does not match the expected checksum-locked source/i);
  assert.match(migration, /if pg_catalog\.strpos\(current_definition, 'scheduled_open_play_slots as materialized'/i);
});

test('Open Play demand production migration is checksum locked and verified', () => {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  assert.match(workflow, new RegExp(`MIGRATION_SHA256:\\s*${checksum}`, 'i'));
  assert.match(workflow, /Read-only production preflight/i);
  assert.match(workflow, /Apply checksum-locked migration exactly once/i);
  const applyStep = workflow.slice(
    workflow.indexOf('- name: Apply checksum-locked migration exactly once'),
    workflow.indexOf('- name: Verify production database state'),
  );
  assert.doesNotMatch(applyStep, /--retry\b/i);
  assert.match(workflow, /Open Play demand inclusion verified/i);
});
