import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export class Vault {
  constructor(file, secret) {
    if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as hex.');
    this.key = Buffer.from(secret, 'hex');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vault (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL DEFAULT 0);');
    if (file !== ':memory:') fs.chmodSync(file, 0o600);
  }
  set(key, value, lifetime = 0) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    this.db.prepare('INSERT INTO vault(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires=excluded.expires').run(key, sealed, lifetime ? Date.now() + lifetime * 1000 : 0);
  }
  get(key) {
    const row = this.db.prepare('SELECT value,expires FROM vault WHERE key=?').get(key);
    if (!row) return null;
    if (row.expires && row.expires <= Date.now()) { this.delete(key); return null; }
    const sealed = Buffer.from(row.value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, sealed.subarray(0,12));
    decipher.setAAD(Buffer.from(key)); decipher.setAuthTag(sealed.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString());
  }
  delete(key) { this.db.prepare('DELETE FROM vault WHERE key=?').run(key); }
  clean() { this.db.prepare('DELETE FROM vault WHERE expires>0 AND expires<=?').run(Date.now()); }
  close() { this.db.close(); }
}

export function scopedVault(vault, appId) {
  return {get:key=>vault.get(`${appId}:${key}`), set:(key,value,lifetime)=>vault.set(`${appId}:${key}`,value,lifetime), delete:key=>vault.delete(`${appId}:${key}`)};
}
