export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}

export type Actor = { userId: string; moderator: boolean; mediator: boolean };
export type Platform = 'mobile' | 'emulador' | 'misto';
export type MatchState = 'confirming' | 'awaiting_mediator' | 'ready' | 'room_pending'
  | 'room_created' | 'playing' | 'result_pending' | 'disputed' | 'finished' | 'cancelled' | 'expired';
export type GuildConfig = {
  guildId: string; categoryId: string; staffRoleId: string; mediatorRoleId: string;
  analystRoleId?: string;
};
export type Queue = {
  id: string; guildId: string; teamSize: number; platform: Platform; rules: string;
  stakeCents: number; channelId: string | null; messageId: string | null;
};
export type Player = { userId: string; team: 1 | 2; confirmed: boolean };
export type Room = { id: string; password: string; source: 'manual' | 'simulated' | 'external' };
export type Match = {
  id: string; guildId: string; queueId: string; teamSize: number; platform: Platform;
  rules: string; stakeCents: number; state: MatchState; players: Player[];
  createdAt: number; expiresAt: number; mediatorId: string | null;
  channelId: string | null; messageId: string | null; room: Room | null;
  roomRequestProvider: 'simulated' | 'external' | null;
  roomRequestIdentity?: string;
  result: { winner: 1 | 2; score: string; acceptedBy: string[]; decision?: { winner: 1 | 2; reason: string } } | null;
  reason: string | null;
};
export const TERMINAL: ReadonlySet<MatchState> = new Set(['finished', 'cancelled', 'expired']);

export function parseMoney(value: string): number {
  requireCondition(/^\d{1,6}([.,]\d{1,2})?$/.test(value), 'INVALID_MONEY', 'Informe o valor como 0,00, com até duas casas decimais.');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export const money = (cents: number): string => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
