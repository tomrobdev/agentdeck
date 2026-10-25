// Calls the running daemon's HTTP API. Work that starts `claude` (resolve, plan) goes through here, so only the
// daemon process ever spawns it. node:http rather than fetch: fetch's 300 s headers timeout would cut off a long resolve.
import { request } from 'node:http';
import { API_PORT } from '../config.ts';
import { die } from './format.ts';

export function callDaemon<T = any>(method: string, path: string, body?: unknown, port = API_PORT): Promise<T> {
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
          let data: any;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            return die(`the daemon answered ${res.statusCode} with something that is not JSON`);
          }
          if (data?.error) return die(String(data.error));
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
