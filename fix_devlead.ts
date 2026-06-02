import { createConnection } from 'typeorm';
import { Client } from 'pg';

const client = new Client({
  host: '127.0.0.1',
  port: 54329,
  user: 'paperclip',
  password: 'paperclip',
  database: 'paperclip',
});

await client.connect();

// Fix threshold
const updateThreshold = `
  UPDATE public.agents
  SET accountabilities = jsonb_set(
    accountabilities,
    '{1,alert_threshold}',
    '5'::jsonb
  )
  WHERE id = 'e1f66962-dc3c-4a8e-9875-de1a1dee2839'
`;
await client.query(updateThreshold);
console.log('✓ Threshold updated to 5');

// Add alert_direction
const updateDirection = `
  UPDATE public.agents
  SET accountabilities = jsonb_set(
    accountabilities,
    '{1,alert_direction}',
    '"higher_is_better"'::jsonb
  )
  WHERE id = 'e1f66962-dc3c-4a8e-9875-de1a1dee2839'
`;
await client.query(updateDirection);
console.log('✓ alert_direction set to higher_is_better');

// Verify
const result = await client.query(`
  SELECT accountabilities
  FROM public.agents
  WHERE id = 'e1f66962-dc3c-4a8e-9875-de1a1dee2839'
`);
console.log('✓ Verified:', JSON.stringify(result.rows[0].accountabilities, null, 2));

await client.end();
