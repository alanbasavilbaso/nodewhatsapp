import WhatsAppService from './whatsappService.js';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';

class WhatsAppManager {
  constructor() {
    this.instances = new Map(); // phoneNumber -> WhatsAppService
    
    // Usar variable de entorno para Railway o directorio local por defecto
    this.authBaseDir = process.env.AUTH_DATA_DIR || './auth_info_baileys';
    
    // Crear directorio base si no existe
    if (!fs.existsSync(this.authBaseDir)) {
      fs.mkdirSync(this.authBaseDir, { recursive: true });
      logger.info(`Created auth directory: ${this.authBaseDir}`);
    }
    
    logger.info(`Using auth directory: ${this.authBaseDir}`);
  }

  // Obtener o crear instancia para un número
  async getInstance(phoneNumber) {
    // Limpiar y normalizar número
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    if (this.instances.has(cleanNumber)) {
      return this.instances.get(cleanNumber);
    }

    // Crear nueva instancia
    const authDir = path.join(this.authBaseDir, cleanNumber);
    const instance = new WhatsAppService(cleanNumber, authDir, this);
    
    this.instances.set(cleanNumber, instance);
    
    // Inicializar la instancia
    try {
      await instance.initialize();
      logger.info(`✅ Instancia creada para ${cleanNumber}`);
    } catch (error) {
      logger.error(`❌ Error creando instancia para ${cleanNumber}:`, error);
      this.instances.delete(cleanNumber);
      throw error;
    }
    
    return instance;
  }

  // Obtener todas las instancias activas
  getAllInstances() {
    const instances = {};
    for (const [phoneNumber, service] of this.instances) {
      instances[phoneNumber] = service.getConnectionState();
    }
    return instances;
  }

  // Cerrar instancia específica
  async closeInstance(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const instance = this.instances.get(cleanNumber);
    
    if (instance) {
      await instance.gracefulShutdown();
      this.instances.delete(cleanNumber);
      logger.info(`🔄 Instancia cerrada para ${cleanNumber}`);
    }
  }

  // Eliminar instancia completamente (incluyendo archivos de auth)
  async removeInstanceCompletely(phoneNumber) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const instance = this.instances.get(cleanNumber);
    
    if (instance) {
      // Cerrar la instancia
      await instance.gracefulShutdown();
      this.instances.delete(cleanNumber);
      
      // Eliminar archivos de autenticación
      const authDir = path.join(this.authBaseDir, cleanNumber);
      if (fs.existsSync(authDir)) {
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
          logger.info(`🗑️ Archivos de autenticación eliminados para ${cleanNumber}`);
        } catch (error) {
          logger.error(`❌ Error eliminando archivos de auth para ${cleanNumber}:`, error);
        }
      }
      
      logger.info(`🔄 Instancia eliminada completamente para ${cleanNumber}`);
    }
  }

  // Cerrar todas las instancias
  async closeAllInstances() {
    const promises = [];
    for (const [phoneNumber, instance] of this.instances) {
      promises.push(instance.gracefulShutdown());
    }
    
    await Promise.all(promises);
    this.instances.clear();
    logger.info('🔄 Todas las instancias cerradas');
  }

  // Cargar instancias existentes al iniciar
  async loadExistingInstances() {
    try {
      if (!fs.existsSync(this.authBaseDir)) {
        return;
      }

      const authDirs = fs.readdirSync(this.authBaseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const phoneNumber of authDirs) {
        // Solo cargar si tiene credenciales válidas
        const credsPath = path.join(this.authBaseDir, phoneNumber, 'creds.json');
        if (fs.existsSync(credsPath)) {
          try {
            await this.getInstance(phoneNumber);
            logger.info(`🔄 Instancia restaurada para ${phoneNumber}`);
          } catch (error) {
            logger.warn(`⚠️ No se pudo restaurar instancia para ${phoneNumber}:`, error.message);
          }
        }
      }
    } catch (error) {
      logger.error('Error cargando instancias existentes:', error);
    }
  }
}

// Cambiar de module.exports a export default
export default WhatsAppManager;