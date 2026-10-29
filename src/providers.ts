import { DomainError, requireCondition, type Room } from './domain.js';

export interface RoomProvider {
  readonly kind: 'simulated' | 'external';
  readonly identity?: string;
  createRoom(reference: string): Promise<Room>;
  // Retorna undefined quando o resultado continua incerto. Nunca recria a sala.
  findRoom(reference: string): Promise<Room | undefined>;
}

export class RoomNotCreatedError extends DomainError {
  constructor(message: string) { super('ROOM_NOT_CREATED', message); }
}

export class SimulatedRoomProvider implements RoomProvider {
  readonly kind = 'simulated' as const;
  async createRoom(reference: string): Promise<Room> {
    return { id: `SIM-${reference.slice(0, 8)}`, password: 'DEMO', source: 'simulated' };
  }
  async findRoom(reference: string): Promise<Room> { return this.createRoom(reference); }
}

export function validateRoom(room: Room): void {
  requireCondition(typeof room.id === 'string' && /^[\w-]{1,64}$/.test(room.id), 'INVALID_ROOM', 'O provedor retornou um ID de sala inválido.');
  requireCondition(typeof room.password === 'string' && /^[\w-]{1,64}$/.test(room.password), 'INVALID_ROOM', 'Informe uma senha de sala com 1 a 64 letras, números, _ ou -.');
}
