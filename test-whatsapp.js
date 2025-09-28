import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

async function testWhatsApp() {
  try {
    console.log('🚀 Iniciando test de WhatsApp...');
    
    // Usar directorio temporal para test
    const { state, saveCreds } = await useMultiFileAuthState('./test_auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`📦 Baileys v${version.join('.')}, es la última: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: {
        level: 'info',
        trace: () => {},
        debug: () => {},
        info: (msg) => console.log('INFO:', msg),
        warn: (msg) => console.log('WARN:', msg),
        error: (msg) => console.log('ERROR:', msg),
        fatal: (msg) => console.log('FATAL:', msg),
        child: () => ({
          level: 'info',
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          fatal: () => {}
        })
      },
      browser: ['Test WhatsApp', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 QR generado!');
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          console.log('🔗 QR en base64:', qrDataURL.substring(0, 100) + '...');
          console.log('📋 Copia este link en el navegador para ver el QR:');
          console.log(qrDataURL);
        } catch (error) {
          console.log('❌ Error generando QR:', error);
        }
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Conexión cerrada:', lastDisconnect?.error?.output?.statusCode);
        
        if (shouldReconnect) {
          console.log('🔄 Intentando reconectar...');
          setTimeout(() => testWhatsApp(), 3000);
        } else {
          console.log('🛑 No se reconectará (logged out)');
          process.exit(0);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado exitosamente!');
        
        // Test de envío de mensaje
        try {
          console.log('📤 Enviando mensaje de test...');
          await sock.sendMessage('5492346334077@s.whatsapp.net', { 
            text: '🤖 Test desde script directo - ' + new Date().toLocaleString() 
          });
          console.log('✅ Mensaje enviado exitosamente!');
        } catch (error) {
          console.log('❌ Error enviando mensaje:', error);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Mantener el proceso vivo
    process.on('SIGINT', async () => {
      console.log('🛑 Cerrando conexión...');
      sock.end();
      process.exit(0);
    });

  } catch (error) {
    console.error('💥 Error en test:', error);
  }
}

// Ejecutar test
testWhatsApp();