// server.js - Backend ottimizzato per hosting GRATIS (Render/Railway)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connessione e inizializza database
async function initDatabase() {
  try {
    // Test connessione
    const client = await pool.connect();
    console.log('✅ Connesso a PostgreSQL');
    
    // Crea tabella se non esiste
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        guests INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Crea indici per performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    `);
    
    // Crea funzione per auto-update timestamp
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    await client.query(`
      DROP TRIGGER IF EXISTS trigger_update_bookings ON bookings;
      CREATE TRIGGER trigger_update_bookings
      BEFORE UPDATE ON bookings
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
    `);
    
    console.log('✅ Tabella bookings creata/verificata');
    client.release();
  } catch (error) {
    console.error('❌ Errore inizializzazione database:', error);
    throw error;
  }
}

// ==================== API ENDPOINTS ====================

// ==================== AUTENTICAZIONE ADMIN ====================

// Tabella admin users (da creare una volta)
async function createAdminTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Crea admin di default (password: admin123)
    // Hash generato con bcrypt per 'admin123'
    await pool.query(`
      INSERT INTO admin_users (username, password_hash)
      VALUES ('admin', '$2a$10$8K1p/a0dL3LkzJ7dJ5uHxOZbrWpx8vqZJ1mY8TlBCJYY9QqJ7mKuO')
      ON CONFLICT (username) DO NOTHING;
    `);
    
    console.log('✅ Tabella admin_users creata');
  } catch (error) {
    console.error('Errore creazione tabella admin:', error);
  }
}

// Login admin
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username e password richiesti' });
    }
    
    // Per semplicità usiamo credenziali hardcoded
    // In produzione dovresti usare bcrypt e database
    const validUsername = process.env.ADMIN_USERNAME || 'admin';
    const validPassword = process.env.ADMIN_PASSWORD || 'villamarina2026';
    
    if (username === validUsername && password === validPassword) {
      // In produzione generare JWT token qui
      res.json({ 
        success: true,
        message: 'Login effettuato',
        token: 'admin-authenticated' // Placeholder - usare JWT in produzione
      });
    } else {
      res.status(401).json({ error: 'Credenziali non valide' });
    }
  } catch (error) {
    console.error('Errore login:', error);
    res.status(500).json({ error: 'Errore durante il login' });
  }
});

// ==================== BOOKING ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    service: 'Villa Marina Booking API'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Villa Marina Booking API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      bookings: '/api/bookings',
      availability: '/api/availability',
      stats: '/api/stats'
    }
  });
});

// GET - Tutte le prenotazioni
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bookings ORDER BY start_date ASC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Errore GET /api/bookings:', error);
    res.status(500).json({ error: 'Errore recupero prenotazioni' });
  }
});

// GET - Prenotazioni in range di date
app.get('/api/bookings/range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Parametri startDate e endDate richiesti' });
    }
    
    // FIX: Logica corretta - il checkout di una prenotazione libera il giorno per il checkin successivo
    const result = await pool.query(
      `SELECT * FROM bookings 
       WHERE (start_date < $2 AND end_date > $1)
       AND status != 'cancelled'
       ORDER BY start_date ASC`,
      [startDate, endDate]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Errore GET /api/bookings/range:', error);
    res.status(500).json({ error: 'Errore recupero prenotazioni' });
  }
});

// GET - Verifica disponibilità
app.get('/api/availability', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Parametri startDate e endDate richiesti' });
    }
    
    // FIX: Logica corretta per disponibilità
    // Una prenotazione è in conflitto solo se:
    // - inizia prima della fine della nuova prenotazione E
    // - finisce dopo l'inizio della nuova prenotazione
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM bookings 
       WHERE (start_date < $2 AND end_date > $1)
       AND status != 'cancelled'`,
      [startDate, endDate]
    );
    
    const isAvailable = parseInt(result.rows[0].count) === 0;
    
    res.json({ 
      available: isAvailable,
      startDate,
      endDate
    });
  } catch (error) {
    console.error('Errore GET /api/availability:', error);
    res.status(500).json({ error: 'Errore verifica disponibilità' });
  }
});

// POST - Crea nuova prenotazione
app.post('/api/bookings', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { name, email, phone, guests, startDate, endDate, price, notes } = req.body;
    
    // Validazione
    if (!name || !email || !phone || !guests || !startDate || !endDate || !price) {
      return res.status(400).json({ 
        error: 'Campi obbligatori mancanti',
        required: ['name', 'email', 'phone', 'guests', 'startDate', 'endDate', 'price']
      });
    }
    
    // Inizia transazione
    await client.query('BEGIN');
    
    // FIX: Verifica disponibilità con logica corretta
    const checkAvailability = await client.query(
      `SELECT id FROM bookings 
       WHERE (start_date < $2 AND end_date > $1)
       AND status != 'cancelled'
       FOR UPDATE`,
      [startDate, endDate]
    );
    
    if (checkAvailability.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'Date non disponibili',
        conflictingBookings: checkAvailability.rows
      });
    }
    
    // Inserisci prenotazione in stato PENDING
    const result = await client.query(
      `INSERT INTO bookings (name, email, phone, guests, start_date, end_date, price, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [name, email, phone, guests, startDate, endDate, price, notes || null]
    );
    
    // Commit transazione
    await client.query('COMMIT');
    
    console.log('✅ Nuova prenotazione creata:', result.rows[0].id);
    
    res.status(201).json({
      message: 'Prenotazione creata con successo',
      booking: result.rows[0]
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Errore POST /api/bookings:', error);
    res.status(500).json({ error: 'Errore creazione prenotazione' });
  } finally {
    client.release();
  }
});

// GET - Singola prenotazione
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Errore GET /api/bookings/:id:', error);
    res.status(500).json({ error: 'Errore recupero prenotazione' });
  }
});

// PUT - Aggiorna prenotazione
app.put('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, guests, startDate, endDate, price, status, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE bookings 
       SET name = $1, email = $2, phone = $3, guests = $4, 
           start_date = $5, end_date = $6, price = $7, status = $8, notes = $9
       WHERE id = $10
       RETURNING *`,
      [name, email, phone, guests, startDate, endDate, price, status, notes, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    
    console.log('✅ Prenotazione aggiornata:', id);
    res.json({ 
      message: 'Prenotazione aggiornata con successo', 
      booking: result.rows[0] 
    });
  } catch (error) {
    console.error('Errore PUT /api/bookings/:id:', error);
    res.status(500).json({ error: 'Errore aggiornamento prenotazione' });
  }
});

// DELETE - Cancella prenotazione (eliminazione permanente)
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `DELETE FROM bookings WHERE id = $1 RETURNING *`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prenotazione non trovata' });
    }
    
    console.log('✅ Prenotazione eliminata permanentemente:', id);
    res.json({ 
      message: 'Prenotazione eliminata con successo',
      booking: result.rows[0]
    });
  } catch (error) {
    console.error('Errore DELETE /api/bookings/:id:', error);
    res.status(500).json({ error: 'Errore cancellazione prenotazione' });
  }
});

// GET - Statistiche
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_bookings,
        COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COALESCE(SUM(price) FILTER (WHERE status = 'confirmed'), 0) as total_revenue,
        COALESCE(AVG(price) FILTER (WHERE status = 'confirmed'), 0) as avg_booking_price,
        COUNT(*) FILTER (WHERE start_date >= CURRENT_DATE) as upcoming_bookings
      FROM bookings
    `);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Errore GET /api/stats:', error);
    res.status(500).json({ error: 'Errore recupero statistiche' });
  }
});

// Gestione errori 404
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint non trovato',
    path: req.path,
    method: req.method
  });
});

// Gestione errori globali
app.use((err, req, res, next) => {
  console.error('Errore globale:', err);
  res.status(500).json({ 
    error: 'Errore interno del server',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Avvia server
const startServer = async () => {
  try {
    await initDatabase();
    await createAdminTable(); // Crea tabella admin
    
    app.listen(PORT, () => {
      console.log(`🚀 Server avviato su porta ${PORT}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
      console.log(`📊 API base: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('❌ Errore avvio server:', error);
    process.exit(1);
  }
};

// Gestione shutdown graceful
process.on('SIGTERM', async () => {
  console.log('SIGTERM ricevuto, chiusura graceful...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT ricevuto, chiusura graceful...');
  await pool.end();
  process.exit(0);
});

// Gestione errori non catturati
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Avvia
startServer();
