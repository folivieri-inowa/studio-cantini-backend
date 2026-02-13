#!/bin/bash

# ==========================================
# Script di Backfill per Produzione
# ==========================================
# Popola classification_feedback con i dati storici
# per permettere all'analytics AI di vedere tutti i 7410 record
# 
# UTILIZZO:
#   ./backfill-production.sh
# 
# OPPURE con kubectl (se database in K8s):
#   kubectl exec -n studio-cantini postgresql-0 -- psql -U postgres -d studio-cantini -f /path/to/backfill-production.sql
# ==========================================

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/backfill-production.sql"

# Colori per output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}=====================================${NC}"
echo -e "${BLUE}🚀 BACKFILL CLASSIFICATION FEEDBACK${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""

# Verifica che il file SQL esista
if [ ! -f "$SQL_FILE" ]; then
    echo -e "${RED}❌ Errore: File $SQL_FILE non trovato${NC}"
    exit 1
fi

echo -e "${YELLOW}⚠️  Questo script popolerà classification_feedback con ~7000 record storici${NC}"
echo -e "${YELLOW}   Database target: PRODUZIONE${NC}"
echo ""
echo -e "Opzioni di esecuzione:"
echo ""
echo -e "1) ${GREEN}Kubernetes${NC} - Database PostgreSQL in cluster K8s"
echo -e "   kubectl exec -n studio-cantini postgresql-0 -- psql -U postgres -d studio-cantini < $SQL_FILE"
echo ""
echo -e "2) ${GREEN}Locale/Remote psql${NC} - Connessione diretta con psql"
echo -e "   psql <POSTGRES_URL> -f $SQL_FILE"
echo ""
echo -e "3) ${GREEN}Docker${NC} - Database in container Docker"
echo -e "   docker exec -i postgres-container psql -U postgres -d studio-cantini < $SQL_FILE"
echo ""

# Chiedi conferma
read -p "Vuoi procedere con Kubernetes (k), psql (p), Docker (d) o annullare (q)? " choice

case "$choice" in
  k|K)
    echo ""
    echo -e "${BLUE}Esecuzione tramite Kubernetes...${NC}"
    
    # Verifica che kubectl sia disponibile
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}❌ kubectl non trovato. Installalo o usa un'altra opzione.${NC}"
        exit 1
    fi
    
    # Verifica namespace e pod
    read -p "Nome namespace (default: studio-cantini): " namespace
    namespace=${namespace:-studio-cantini}
    
    read -p "Nome pod PostgreSQL (default: postgresql-0): " pod_name
    pod_name=${pod_name:-postgresql-0}
    
    read -p "Database name (default: studio-cantini): " db_name
    db_name=${db_name:-studio-cantini}
    
    echo ""
    echo -e "${YELLOW}Eseguo: kubectl exec -n $namespace $pod_name -- psql -U postgres -d $db_name${NC}"
    echo ""
    
    cat "$SQL_FILE" | kubectl exec -i -n "$namespace" "$pod_name" -- psql -U postgres -d "$db_name"
    
    echo ""
    echo -e "${GREEN}✅ Backfill completato con successo!${NC}"
    ;;
    
  p|P)
    echo ""
    echo -e "${BLUE}Esecuzione tramite psql...${NC}"
    
    if [ -z "$POSTGRES_URL" ]; then
        read -p "Inserisci POSTGRES_URL: " postgres_url
    else
        postgres_url=$POSTGRES_URL
        echo -e "${GREEN}Uso POSTGRES_URL da variabile d'ambiente${NC}"
    fi
    
    echo ""
    echo -e "${YELLOW}Eseguo: psql $postgres_url -f $SQL_FILE${NC}"
    echo ""
    
    psql "$postgres_url" -f "$SQL_FILE"
    
    echo ""
    echo -e "${GREEN}✅ Backfill completato con successo!${NC}"
    ;;
    
  d|D)
    echo ""
    echo -e "${BLUE}Esecuzione tramite Docker...${NC}"
    
    read -p "Nome container (default: postgres): " container_name
    container_name=${container_name:-postgres}
    
    read -p "Database name (default: studio-cantini): " db_name
    db_name=${db_name:-studio-cantini}
    
    read -p "Username (default: postgres): " db_user
    db_user=${db_user:-postgres}
    
    echo ""
    echo -e "${YELLOW}Eseguo: docker exec -i $container_name psql -U $db_user -d $db_name${NC}"
    echo ""
    
    cat "$SQL_FILE" | docker exec -i "$container_name" psql -U "$db_user" -d "$db_name"
    
    echo ""
    echo -e "${GREEN}✅ Backfill completato con successo!${NC}"
    ;;
    
  q|Q)
    echo ""
    echo -e "${YELLOW}Operazione annullata${NC}"
    exit 0
    ;;
    
  *)
    echo ""
    echo -e "${RED}Scelta non valida${NC}"
    exit 1
    ;;
esac

echo ""
echo -e "${BLUE}=====================================${NC}"
echo -e "${GREEN}🎉 COMPLETATO!${NC}"
echo -e "${BLUE}=====================================${NC}"
echo ""
echo -e "${GREEN}💡 Ora lo strumento di analisi AI può vedere tutti i dati storici!${NC}"
echo -e "   Vai su: Dashboard > Machine Learning > Analytics"
echo ""
