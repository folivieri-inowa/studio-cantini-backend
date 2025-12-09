-- Migration: Create classification_feedback table
-- Created: 2025-01-09
-- Description: Stores user corrections to AI classifications for learning purposes

-- Enable pg_trgm extension for similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS classification_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    db VARCHAR(255) NOT NULL,
    
    -- Original transaction info
    transaction_id UUID NOT NULL,
    original_description TEXT NOT NULL,
    amount DECIMAL(15, 2),
    transaction_date DATE,
    
    -- AI suggestion (what was proposed)
    suggested_category_id UUID,
    suggested_subject_id UUID,
    suggested_detail_id UUID,
    suggestion_confidence DECIMAL(5, 2),
    suggestion_method VARCHAR(50),
    
    -- User correction (what was actually chosen)
    corrected_category_id UUID NOT NULL,
    corrected_subject_id UUID NOT NULL,
    corrected_detail_id UUID,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Indexes for fast retrieval
    CONSTRAINT fk_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

-- Index for fast similarity searches using trigrams
CREATE INDEX IF NOT EXISTS idx_feedback_description_trgm ON classification_feedback USING gin(original_description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_feedback_db ON classification_feedback(db);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON classification_feedback(corrected_category_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON classification_feedback(created_at DESC);

-- Comments
COMMENT ON TABLE classification_feedback IS 'Stores user corrections to AI classifications for learning and improving future suggestions';
COMMENT ON COLUMN classification_feedback.suggestion_method IS 'rag_direct, rag_ai, etc - method used for original suggestion';
COMMENT ON COLUMN classification_feedback.suggestion_confidence IS 'Confidence percentage (0-100) of original suggestion';
