#!/usr/bin/env node

/**
 * Migration script: generates embeddings for existing experiences.
 * Run once after upgrading to v2.0.0.
 *
 * 1. Soft-deletes auto_capture records (noise from old hooks)
 * 2. Generates embeddings for all active experiences + corrections
 * 3. Inserts embeddings into vec_experiences table
 *
 * Usage: node build/migrate-embeddings.js
 */

import db, {
  upsertVector,
  upsertPrefVector,
  vectorsAvailable,
  checkpoint,
} from "./database.js";
import { getEmbedding } from "./embeddings.js";

async function migrate() {
  console.log("=== Agent Memory: Embedding Migration ===\n");

  // Step 1: Soft-delete auto_captures
  const autoCaptures = db
    .prepare(
      `SELECT COUNT(*) as count FROM experiences WHERE type = 'auto_capture' AND deleted_at IS NULL`
    )
    .get() as any;

  if (autoCaptures.count > 0) {
    console.log(`Soft-deleting ${autoCaptures.count} auto_capture records...`);
    db.prepare(
      `UPDATE experiences SET deleted_at = datetime('now') WHERE type = 'auto_capture' AND deleted_at IS NULL`
    ).run();
    checkpoint();
    console.log("Done.\n");
  }

  // Step 2: Get all active experiences that need embeddings
  const experiences = db
    .prepare(
      `SELECT id, type, context, action, result
       FROM experiences
       WHERE deleted_at IS NULL
         AND type IN ('experience', 'correction')
       ORDER BY id ASC`
    )
    .all() as any[];

  console.log(`Found ${experiences.length} records to embed.\n`);

  if (experiences.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!vectorsAvailable) {
    console.error("ERROR: sqlite-vec no disponible. No se pueden generar vectores.");
    process.exit(1);
  }

  // Step 3: Generate embeddings one by one (with progress)
  let done = 0;
  let errors = 0;

  for (const exp of experiences) {
    const text = `${exp.context || ""} ${exp.action || ""} ${exp.result || ""}`.trim();
    if (!text) {
      done++;
      continue;
    }

    try {
      const embedding = await getEmbedding(text);
      if (!embedding) { errors++; continue; }

      // Upsert: delete + insert (idempotente)
      upsertVector(exp.id, embedding);

      done++;
      if (done % 50 === 0 || done === experiences.length) {
        const pct = Math.round((done / experiences.length) * 100);
        console.log(`  [${pct}%] ${done}/${experiences.length} embeddings generated`);
      }
    } catch (err) {
      errors++;
      console.error(`  Error on id ${exp.id}: ${err}`);
    }
  }

  checkpoint();

  // Step 4: Generate embeddings for all preferences
  const preferences = db
    .prepare(`SELECT id, key, value FROM preferences ORDER BY id ASC`)
    .all() as any[];

  console.log(`\nFound ${preferences.length} preferences to embed.\n`);

  let prefDone = 0;
  let prefErrors = 0;

  for (const pref of preferences) {
    const keyWords = pref.key.replace(/_/g, " ");
    const text = `user preference ${keyWords}: ${pref.value}`;
    try {
      const embedding = await getEmbedding(text);
      if (!embedding) { prefErrors++; continue; }
      upsertPrefVector(pref.id, embedding);
      prefDone++;
      if (prefDone % 20 === 0 || prefDone === preferences.length) {
        const pct = Math.round((prefDone / preferences.length) * 100);
        console.log(`  [${pct}%] ${prefDone}/${preferences.length} preference embeddings generated`);
      }
    } catch (err) {
      prefErrors++;
      console.error(`  Error on pref id ${pref.id}: ${err}`);
    }
  }

  checkpoint();

  // Summary
  const vecCount = (
    db.prepare(`SELECT COUNT(*) as count FROM vec_experiences`).get() as any
  ).count;
  const prefVecCount = (
    db.prepare(`SELECT COUNT(*) as count FROM vec_preferences`).get() as any
  ).count;

  console.log(`\n=== Migration Complete ===`);
  console.log(`  Experience embeddings: ${done - errors}/${experiences.length}`);
  console.log(`  Preference embeddings: ${prefDone - prefErrors}/${preferences.length}`);
  console.log(`  Errors: ${errors + prefErrors}`);
  console.log(`  Total vectors: ${vecCount} experiences + ${prefVecCount} preferences`);
  console.log(`  Auto-captures soft-deleted: ${autoCaptures.count}`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
