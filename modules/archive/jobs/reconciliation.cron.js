/**
 * Reconciliation Cron Job
 * Esegue reconciliazione periodica PostgreSQL ↔ Qdrant
 * Da schedulare con cron (es. ogni notte alle 2:00 AM)
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { ReconciliationService } from '../services/reconciliation.service.js';

const { Pool } = pg;

// Configurazione
const DRY_RUN = process.env.RECONCILIATION_DRY_RUN === 'true';
const AUTO_REPAIR = process.env.RECONCILIATION_AUTO_REPAIR === 'true';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'archive_documents';

async function runReconciliation() {
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

  try {
    console.log('🔄 ==========================================');
    console.log('🔄 Reconciliation Job Started');
    console.log('🔄 ==========================================');
    console.log(`⏰ Time: ${new Date().toISOString()}`);
    console.log(`🧪 Dry Run: ${DRY_RUN ? 'YES' : 'NO'}`);
    console.log(`🔧 Auto Repair: ${AUTO_REPAIR ? 'YES' : 'NO'}`);
    console.log(`☁️ Qdrant: ${QDRANT_URL}`);
    console.log(`📦 Collection: ${QDRANT_COLLECTION}`);
    console.log('🔄 ==========================================\n');

    const reconciliationService = new ReconciliationService(
      pool,
      QDRANT_URL,
      QDRANT_COLLECTION
    );

    // 1. Health Check
    console.log('📊 Step 1/3: Health Check');
    const healthReport = await reconciliationService.healthCheck();

    console.log('\n📊 Health Report:');
    console.log(`   PostgreSQL Chunks: ${healthReport.postgresql.totalChunks}`);
    console.log(`   PostgreSQL Synced: ${healthReport.postgresql.syncedChunks}`);
    console.log(`   PostgreSQL Unsynced: ${healthReport.postgresql.unsyncedChunks}`);
    console.log(`   Qdrant Points: ${healthReport.qdrant.totalPoints}`);
    console.log(`   Consistency: ${healthReport.consistency.isConsistent ? '✅ OK' : '⚠️ ISSUES'}`);

    if (healthReport.consistency.missingInQdrant > 0) {
      console.log(`   ⚠️ Missing in Qdrant: ${healthReport.consistency.missingInQdrant}`);
    }
    if (healthReport.consistency.orphanedInQdrant > 0) {
      console.log(`   ⚠️ Orphaned in Qdrant: ${healthReport.consistency.orphanedInQdrant}`);
    }
    if (healthReport.consistency.mismatchedSync > 0) {
      console.log(`   ⚠️ Mismatched Sync: ${healthReport.consistency.mismatchedSync}`);
    }

    // 2. Detect Drift
    console.log('\n🔍 Step 2/3: Drift Detection');
    const driftReport = await reconciliationService.detectDrift();

    console.log(`\n🔍 Drift Report:`);
    console.log(`   Missing Chunks: ${driftReport.missingChunks.length}`);
    console.log(`   Orphaned Points: ${driftReport.orphanedPoints.length}`);
    console.log(`   Mismatched: ${driftReport.mismatchedChunks.length}`);

    if (driftReport.missingChunks.length > 0) {
      console.log(`\n   📝 Sample Missing Chunks (first 5):`);
      driftReport.missingChunks.slice(0, 5).forEach((chunk) => {
        console.log(`      - ${chunk.id} (doc: ${chunk.document_id})`);
      });
    }

    if (driftReport.orphanedPoints.length > 0) {
      console.log(`\n   🗑️ Sample Orphaned Points (first 5):`);
      driftReport.orphanedPoints.slice(0, 5).forEach((point) => {
        console.log(`      - ${point.id}`);
      });
    }

    // 3. Auto Repair (se abilitato e non dry-run)
    if (AUTO_REPAIR && !DRY_RUN) {
      console.log('\n🔧 Step 3/3: Auto Repair');
      const repairReport = await reconciliationService.repairDrift(driftReport);

      console.log(`\n🔧 Repair Report:`);
      console.log(`   Synced to Qdrant: ${repairReport.syncedToQdrant}`);
      console.log(`   Removed from Qdrant: ${repairReport.removedFromQdrant}`);
      console.log(`   Updated Sync Status: ${repairReport.updatedSyncStatus}`);
      console.log(`   Errors: ${repairReport.errors.length}`);

      if (repairReport.errors.length > 0) {
        console.log(`\n   ❌ Errors during repair:`);
        repairReport.errors.forEach((error, index) => {
          console.log(`      ${index + 1}. ${error}`);
        });
      }
    } else if (DRY_RUN) {
      console.log('\n🧪 Step 3/3: Skipped (Dry Run)');
      console.log('   Set RECONCILIATION_DRY_RUN=false to enable repairs');
    } else {
      console.log('\n⏭️ Step 3/3: Skipped (Auto Repair Disabled)');
      console.log('   Set RECONCILIATION_AUTO_REPAIR=true to enable repairs');
    }

    // 4. Final Summary
    console.log('\n🎯 ==========================================');
    console.log('🎯 Reconciliation Summary');
    console.log('🎯 ==========================================');
    console.log(`   Status: ${healthReport.consistency.isConsistent ? '✅ HEALTHY' : '⚠️ NEEDS ATTENTION'}`);
    console.log(`   Total Issues: ${driftReport.missingChunks.length + driftReport.orphanedPoints.length + driftReport.mismatchedChunks.length}`);
    
    if (AUTO_REPAIR && !DRY_RUN) {
      console.log(`   Repairs Made: YES`);
    } else {
      console.log(`   Repairs Made: NO`);
    }

    console.log(`   Completed: ${new Date().toISOString()}`);
    console.log('🎯 ==========================================\n');

    // Exit code
    const hasIssues = !healthReport.consistency.isConsistent;
    process.exit(hasIssues ? 1 : 0);
  } catch (error) {
    console.error('\n❌ ==========================================');
    console.error('❌ Reconciliation Job FAILED');
    console.error('❌ ==========================================');
    console.error('❌ Error:', error.message);
    console.error('❌ Stack:', error.stack);
    console.error('❌ ==========================================\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Esegui reconciliation
runReconciliation();
