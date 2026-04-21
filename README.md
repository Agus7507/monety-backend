# Monety Backend — API REST

API REST para el sistema de solicitud y gestión de préstamos de Monety.  
Stack: **Node.js 20 + Express 4 + PostgreSQL 15**

---

## Estructura del proyecto

```
monety-backend/
├── src/
│   ├── config/
│   │   ├── db.js          ← Pool de conexiones PostgreSQL
│   │   └── logger.js      ← Winston (JSON en prod, coloreado en dev)
│   ├── middleware/
│   │   ├── auth.js        ← JWT + control de roles
│   │   └── errorHandler.js← Validaciones y errores globales
│   ├── routes/
│   │   ├── auth.js        ← POST /login  GET /me
│   │   ├── simulador.js   ← POST /simulador   (público)
│   │   ├── solicitudes.js ← CRUD + flujo de estados
│   │   ├── creditos.js    ← Formalización + amortización
│   │   ├── empresas.js    ← Catálogo de empresas
│   │   └── dashboard.js   ← KPIs ejecutivos
│   ├── controllers/
│   │   └── solicitudesController.js ← Lógica de negocio principal
│   ├── services/
│   │   └── scoringService.js ← Algoritmo.xlsx implementado en JS
│   ├── app.js             ← Express app (middlewares + rutas)
│   └── server.js          ← Entrypoint + arranque
├── tests/
│   └── scoring.test.js    ← Tests unitarios del algoritmo
├── .env.example
└── package.json
```

---

## Configuración rápida

### 1. Requisitos previos
- Node.js ≥ 20
- PostgreSQL ≥ 15
- npm

### 2. Clonar e instalar
```bash
git clone <repo>
cd monety-backend
npm install
```

### 3. Variables de entorno
```bash
cp .env.example .env
# Edita .env con tus credenciales de BD
```

### 4. Crear la base de datos
```bash
psql -U postgres -c "CREATE DATABASE monety_db;"
psql -U postgres -c "CREATE USER monety_user WITH PASSWORD 'tu_password';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE monety_db TO monety_user;"
psql -U monety_user -d monety_db -f monety_schema.sql
```

### 5. Crear el primer usuario admin
```bash
# En psql:
INSERT INTO usuarios_sistema (nombre, apellidos, email, password_hash, rol)
VALUES ('Admin', 'Monety',
        'admin@monety.mx',
        '$2a$10$...', -- bcrypt de tu contraseña
        'ADMIN');

# O usa Node para generar el hash:
node -e "const b=require('bcryptjs'); console.log(b.hashSync('TuPassword123!',10))"
```

### 6. Arrancar
```bash
npm run dev     # desarrollo (nodemon + hot reload)
npm start       # producción
```

---

## Endpoints

### Público (sin autenticación)

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/v1/simulador` | Calcula pago mensual + tabla de amortización |
| `POST` | `/api/v1/solicitudes` | Envía solicitud desde el formulario web |
| `GET`  | `/api/v1/solicitudes/estado/:folio` | Consulta estado por folio |
| `GET`  | `/api/v1/empresas` | Lista de empresas para el formulario |
| `GET`  | `/health` | Health check |

### Interno (requiere `Authorization: Bearer <token>`)

| Método | Ruta | Rol mínimo | Descripción |
|--------|------|-----------|-------------|
| `POST` | `/api/v1/auth/login` | — | Login de agentes |
| `GET`  | `/api/v1/auth/me` | AGENTE | Perfil del usuario |
| `GET`  | `/api/v1/solicitudes` | AGENTE | Listado paginado |
| `GET`  | `/api/v1/solicitudes/:id` | AGENTE | Detalle + historial |
| `PATCH`| `/api/v1/solicitudes/:id/estado` | ANALISTA | Cambiar estado |
| `POST` | `/api/v1/solicitudes/:id/evaluar` | ANALISTA | Re-evaluar scoring |
| `POST` | `/api/v1/creditos` | ANALISTA | Formalizar crédito |
| `GET`  | `/api/v1/creditos` | AGENTE | Cartera activa |
| `GET`  | `/api/v1/creditos/:id/amortizacion` | AGENTE | Tabla de amortización |
| `PATCH`| `/api/v1/creditos/:id/pago/:periodo` | ANALISTA | Registrar pago |
| `GET`  | `/api/v1/dashboard` | AGENTE | KPIs ejecutivos |

---

## Flujo completo de una solicitud

```
[Sitio web] ──POST /simulador──────────────────────► [Resultado estimado]
[Sitio web] ──POST /solicitudes────────────────────► [Folio + scoring automático]
                                                             │
                                    ┌────────────────────────┘
                                    ▼
                      [Backoffice: GET /solicitudes]
                                    │
                    PATCH /solicitudes/:id/estado → EN_REVISION
                                    │
                    POST /solicitudes/:id/evaluar → scoring manual
                                    │
                    PATCH /solicitudes/:id/estado → PRE_APROBADA
                                    │
                    POST /creditos ─────────────► [Crédito + amortización]
                                    │
                    PATCH /creditos/:id/pago/:periodo (cada mes)
```

---

## Conexión con el sitio web

Agrega esto en el HTML del formulario para conectar con la API:

```javascript
// Enviar solicitud desde el sitio web
const response = await fetch('http://localhost:4000/api/v1/solicitudes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombres: 'Juan Pablo',
    apellidoPat: 'González',
    email: 'jp@ejemplo.com',
    telefono: '5512345678',
    empresaId: 1,
    tipoNomina: 'MENSUAL',
    fechaIngresoEmp: '2024-01-15',
    fechaBajaEstim: '2026-12-31',
    salarioBruto: 12000,
    salarioNeto: 9465,
    historialCrediticio: 'BUENO',
    tipoCredito: 'NOMINA',
    montoSolicitado: 15000,
    plazoMeses: 12,
    gastos: 5000,
    tieneDeudas: false,
  })
});
const data = await response.json();
console.log(data.folio);    // "MNT-000001"
console.log(data.scoring);  // { aprobado, ranking, pagoMensual, ... }
```

---

## Tests

```bash
npm test
```

Los tests cubren el `scoringService`: puntajes, rangos, tabla de amortización, casos borde.

---

## Despliegue en producción

Plataformas recomendadas para inicio rápido:

| Servicio | Para qué |
|----------|----------|
| **Railway** | API Node.js + PostgreSQL en un solo proyecto |
| **Render** | Web Service + PostgreSQL managed |
| **Fly.io** | Más control, multi-región |

Variables de entorno obligatorias en producción:
```
NODE_ENV=production
DB_SSL=true
JWT_SECRET=<secreto muy largo y aleatorio>
CORS_ORIGINS=https://monety.mx
```
