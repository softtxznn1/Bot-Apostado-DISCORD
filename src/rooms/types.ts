export type RoomValue = string | number | boolean;
export type RoomActor = { userId: string; roleIds: readonly string[]; administrator: boolean };
export type RemoteRoomState = 'open' | 'running' | 'cancelled' | 'closed' | 'expired';
export type RoomOptionField = {
  id: string; label: string; type: 'string' | 'integer' | 'boolean' | 'choice';
  required?: boolean; editable?: boolean; min?: number; max?: number; maxLength?: number;
  choices?: { value: string; label: string }[];
};
export type RoomMode = {
  id: string; label: string; mapIds: string[]; minPlayers: number; maxPlayers: number;
  playerStep?: number; optionFields: RoomOptionField[];
  editableFields: ('name' | 'modeId' | 'mapId' | 'maxPlayers' | 'password')[];
};
export type RoomCatalog = {
  revision: string; modes: RoomMode[]; maps: { id: string; label: string }[];
  capabilities: { create: boolean; lookup: boolean; query: boolean; update: boolean; cancel: boolean; close: boolean };
};
export type RoomOptions = {
  name: string; modeId: string; mapId: string; maxPlayers: number;
  password?: string; extras: Record<string, RoomValue>;
};
export type ProviderRoom = {
  id: string; reference: string; state: RemoteRoomState;
  name: string; modeId: string; mapId: string; maxPlayers: number;
  password: string | null; extras: Record<string, RoomValue>; expiresAt?: number;
};
export interface ManagedRoomProvider {
  readonly identity: string;
  readonly source: 'simulated' | 'external';
  getCatalog(): Promise<RoomCatalog>;
  createRoom(request: { reference: string; options: RoomOptions; idempotencyKey: string }): Promise<ProviderRoom | undefined>;
  getRoom(remoteId: string): Promise<ProviderRoom>;
  findRoom(reference: string): Promise<ProviderRoom | undefined>;
  updateRoom(remoteId: string, options: RoomOptions, idempotencyKey: string): Promise<ProviderRoom | undefined>;
  cancelRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom | undefined>;
  closeRoom(remoteId: string, idempotencyKey: string, reason: string): Promise<ProviderRoom | undefined>;
}
export type RoomSettings = {
  guildId: string; panelChannelId: string; outputChannelId: string; logChannelId: string | null;
  operatorRoleIds: string[]; managerRoleIds: string[]; viewerRoleIds: string[];
  allowedModeIds: string[]; allowedMapIds: string[];
  allowedExtraIds?: string[];
  maxActivePerUser: number; maxActivePerGuild: number; cooldownSeconds: number;
  panelMessageId?: string | null;
};
export type ManagedRoomState = 'draft' | 'creating' | 'ready' | 'running' | 'updating'
  | 'cancelling' | 'closing' | 'cancelled' | 'closed' | 'expired' | 'uncertain' | 'failed';
export type PendingRoomOperation = {
  id: string; kind: 'create' | 'update' | 'cancel' | 'close';
  idempotencyKey: string; requestedOptions?: RoomOptions; reason?: string;
  startedAt: number;
};
export type ManagedRoom = {
  id: string; guildId: string; creatorId: string; providerIdentity: string;
  source: 'simulated' | 'external'; reference: string; state: ManagedRoomState;
  options: RoomOptions; confirmed: ProviderRoom | null; pending: PendingRoomOperation | null;
  createdAt: number; updatedAt: number; lastSyncedAt: number | null;
  lastErrorCode: string | null; version: number;
  publicationChannelId: string | null; publicationMessageId: string | null;
};
