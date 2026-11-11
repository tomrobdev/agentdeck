// Calls the running daemon's HTTP API.
import { request } from 'node:http';
import { API_PORT } from '../../config.ts';
import { die } from '../format.ts';

export function callDaemon<T>(method: string, path: string, body?: unknown, port = API_PORT): Promise<T> {
  return new Promise<T>((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 0,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => die(`lost the daemon's answer: ${err.message}`));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: unknown;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            return die(`the daemon answered ${res.statusCode} with something that is not JSON`);
          }
          const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
          if (error) return die(String(error));
          if ((res.statusCode ?? 500) >= 400) return die(`the daemon answered ${res.statusCode}`);
          resolve(data as T);
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') return die('the daemon is not running; start it with `agentdeck service start`');
      die(`could not reach the daemon: ${err.message}`);
    });
    req.end(payload);
  });
}
