# Backend Studio Cantini - Configurazione CORS Multi-Dominio

## 🎯 Modifiche Recenti

Il backend è stato aggiornato per supportare **multiple origin CORS** in modo sicuro e configurabile.

### Cosa è cambiato

1. **Configurazione CORS dinamica** - Non più `origin: '*'` hardcoded
2. **Supporto multi-dominio** - Puoi specificare più domini nella variabile `ALLOWED_ORIGINS`
3. **Maggiore sicurezza** - Whitelist esplicita degli origin permessi

## ⚙️ Configurazione

### File `.env`

Aggiungi questa variabile al tuo file `.env`:

```env
ALLOWED_ORIGINS=http://localhost:3000,https://studiocantini.wavetech.it,https://studiocantini.inowa.it
```

**Nota importante:** 
- Gli origin devono essere separati da virgola
- Includi sempre il protocollo (http:// o https://)
- Non aggiungere spazi dopo le virgole
- In produzione, usa solo HTTPS

### Esempio per diversi ambienti

**Development:**
```env
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

**Production:**
```env
ALLOWED_ORIGINS=https://studiocantini.wavetech.it,https://studiocantini.inowa.it
```

## 🧪 Testing

### Test Locale

Avvia il backend:
```bash
yarn dev
```

Testa la configurazione CORS:
```bash
./test-cors.sh http://localhost:9000 http://localhost:3000
```

### Test Produzione

```bash
# Test dominio primario
./test-cors.sh https://api.studiocantini.wavetech.it https://studiocantini.wavetech.it

# Test dominio secondario
./test-cors.sh https://api.studiocantini.wavetech.it https://studiocantini.inowa.it
```

### Test Manuale con curl

```bash
# Test preflight OPTIONS request
curl -i -X OPTIONS \
  -H "Origin: https://studiocantini.inowa.it" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type, Authorization" \
  https://api.studiocantini.wavetech.it/v1/auth/login
```

Dovresti vedere questi headers nella risposta:
```
Access-Control-Allow-Origin: https://studiocantini.inowa.it
Access-Control-Allow-Methods: GET, PUT, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Credentials: true
```

## 🚀 Deploy su Kubernetes

### 1. Aggiorna ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: backend-config
  namespace: studio-cantini
data:
  ALLOWED_ORIGINS: "https://studiocantini.wavetech.it,https://studiocantini.inowa.it"
  # ... altre variabili
```

### 2. Applica e Riavvia

```bash
kubectl apply -f backend-configmap.yaml
kubectl rollout restart deployment/backend-deployment -n studio-cantini
```

### 3. Verifica

```bash
# Controlla i logs
kubectl logs -f deployment/backend-deployment -n studio-cantini

# Testa CORS
./test-cors.sh https://api.studiocantini.wavetech.it https://studiocantini.inowa.it
```

## 🔧 Troubleshooting

### Errore: "Not allowed by CORS"

**Problema:** Il dominio non è nella whitelist

**Soluzione:**
1. Verifica che `ALLOWED_ORIGINS` contenga l'origin corretto
2. Assicurati di includere il protocollo (https://)
3. Riavvia il backend dopo aver modificato `.env`

### Il login fallisce con errore CORS

**Problema:** Il frontend sta usando un origin non permesso

**Soluzione:**
1. Controlla quale origin sta usando il browser (vedi console browser)
2. Aggiungi quell'origin a `ALLOWED_ORIGINS`
3. Riavvia il backend

### In Kubernetes non funziona

**Problema:** La ConfigMap non è stata applicata

**Soluzione:**
```bash
# Verifica la ConfigMap
kubectl get configmap backend-config -n studio-cantini -o yaml

# Verifica le variabili d'ambiente nel pod
kubectl exec -it deployment/backend-deployment -n studio-cantini -- env | grep ALLOWED_ORIGINS

# Riavvia il deployment
kubectl rollout restart deployment/backend-deployment -n studio-cantini
```

## 📚 Documentazione Completa

Per una guida completa sulla configurazione multi-dominio, consulta:
- [docs/MULTI_DOMAIN_SETUP.md](../docs/MULTI_DOMAIN_SETUP.md)

## 🔐 Note di Sicurezza

1. **Mai usare `origin: '*'` in produzione** ❌
2. **Usa sempre HTTPS in produzione** ✅
3. **Mantieni la whitelist aggiornata** ✅
4. **Rimuovi origin non utilizzati** ✅
5. **Usa Secret per dati sensibili** ✅

## ℹ️ Informazioni Tecniche

### Implementazione

La logica CORS è implementata in [index.js](./index.js):

```javascript
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000'];

fastify.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'PUT', 'POST, 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
```

### Features

- ✅ Multiple origin support
- ✅ Dynamic configuration via environment variable
- ✅ Whitelist-based security
- ✅ Credentials support (cookies, authorization headers)
- ✅ Preflight request handling
- ✅ No-origin requests allowed (Postman, curl, server-to-server)
