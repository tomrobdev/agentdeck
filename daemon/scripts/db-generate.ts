import { drizzleKitOnScratch } from './scratch-db.ts';

const { out } = drizzleKitOnScratch(['push', '--explain']);
console.log(out.trim());
