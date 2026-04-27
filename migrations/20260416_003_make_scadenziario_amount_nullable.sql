-- Rende il campo amount opzionale nello scadenziario
ALTER TABLE scadenziario ALTER COLUMN amount DROP NOT NULL;
