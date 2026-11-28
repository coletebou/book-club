import assert from 'node:assert/strict';
import { updateDisplayName } from '../../apps/server/src/repos/users';
import { closeApp, joinClub, makeTestApp, openSocket, outsider, setupOwner } from '../../apps/server/test/helpers';

const test = await makeTestApp();
const sockets: Awaited<ReturnType<typeof openSocket>>[] = [];
try {
  const { owner, club } = await setupOwner(test);
  const reader = await joinClub(test, club, 'Reader');
  const other = await outsider(test, owner);
  const { user } = await owner.json<{ user: { id: string } }>(owner.get('/api/session'), 200);
  for (const member of [owner, reader]) {
    for (let tab = 0; tab < 6; tab++) {
      const socket = await openSocket(test, member);
      sockets.push(socket);
      socket.send({ type: 'subscribe', clubId: club.id });
      await socket.next('presence');
    }
  }
  const outside = await openSocket(test, other);
  try {
    outside.send({ type: 'subscribe', clubId: club.id });
    assert.equal((await outside.next('error')).message, 'Club not found.');
    // Give the measured update a distinct payload from the initial join notifications.
    const displayName = 'Measured reader';
    updateDisplayName(test.ctx.db, user.id, displayName);
    let serializations = 0;
    const stringify = JSON.stringify;
    JSON.stringify = (value: unknown, ...options: unknown[]) => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'presence:update') {
        serializations++;
      }
      return Reflect.apply(stringify, JSON, [value, ...options]);
    };
    try {
      test.ctx.hub.announce(club.id, user.id);
    } finally {
      JSON.stringify = stringify;
    }

    const measured = ({ entry }: { entry: { userId: string; displayName: string } }) =>
      entry.userId === user.id && entry.displayName === displayName;
    const deliveries = await Promise.all(sockets.map((socket) => socket.next('presence:update', measured)));
    assert.equal(deliveries.length, 12);
    for (const packet of deliveries) assert.deepEqual(packet, deliveries[0]);
    assert.equal(await outside.quiet('presence:update', measured), true);
    console.log(JSON.stringify({ connections: sockets.length, serializations, deliveries: deliveries.length }));
    assert.equal(serializations, 1, 'a shared presence update must be serialized once');
  } finally {
    await outside.close();
  }
} finally {
  await Promise.all(sockets.map((socket) => socket.close()));
  await closeApp(test);
}
