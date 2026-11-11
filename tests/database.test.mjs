import test from 'node:test';
import assert from 'node:assert/strict';
import { withTestDatabase } from './helpers.mjs';
import { assertTeamSchema } from '../lib/database.mjs';
import { profileData } from '../lib/profile.mjs';

test('schema guard rejects the older implementation and profile retains unknowns',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    await withTestDatabase(async client => {
      await assertTeamSchema(client);
      let report = await profileData(client);
      assert.equal(report.counts.workload_jobs, 0);
      assert.equal(report.overlap.jobs_with_any_exact_rental_match, 0);
      await client.query("INSERT INTO providers(name) VALUES ('Fixture')");
      await client.query(`INSERT INTO rental_offers(provider_id,source_name,source_offer_id,source_url,native_gpu_name)
        VALUES (1,'fixture','1','https://example.invalid','unknown')`);
      await client.query("INSERT INTO rental_observations(offer_id,observed_at) VALUES (1,'2026-11-11T00:00:00Z')");
      report = await profileData(client);
      assert.equal(report.rentals.unknown_availability, 1);
      assert.equal(report.rentals.unavailable, 0);
      assert.equal(report.rentals.missing_prices, 1);
      await client.query('ALTER TABLE workload_jobs RENAME COLUMN worker_count TO worker_num');
      await assert.rejects(assertTeamSchema(client), /Incompatible team schema/);
    });
  });
