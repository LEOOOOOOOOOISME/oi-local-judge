export interface HubEvent {
  type: string;
  data: unknown;
  room?: string;
}

export interface EventSink {
  publish(event: HubEvent): void;
}

type Client = {
  send(data: string): void;
  readyState?: number;
};

export interface Hub extends EventSink {
  subscribe(client: Client, rooms: string[]): void;
  unsubscribe(client: Client): void;
  roomsOf(client: Client): string[];
}

export function createHub(): Hub {
  const clients = new Map<Client, Set<string>>();

  return {
    publish(event) {
      const payload = JSON.stringify({ v: 1, type: event.type, data: event.data });
      for (const [client, rooms] of clients) {
        if (client.readyState !== undefined && client.readyState !== 1) continue;
        if (event.room && !rooms.has(event.room) && !rooms.has('admin')) continue;
        try {
          client.send(payload);
        } catch {
          clients.delete(client);
        }
      }
    },
    subscribe(client, rooms) {
      clients.set(client, new Set(rooms));
    },
    unsubscribe(client) {
      clients.delete(client);
    },
    roomsOf(client) {
      return [...(clients.get(client) ?? [])];
    },
  };
}
