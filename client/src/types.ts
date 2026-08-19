export interface CardResult {
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
  manaValue?: number;
  type?: string;
}

export interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
  manaCost?: string;
  manaValue?: number;
  type?: string;
}

export interface Deck {
  id: string;
  name: string;
  cards: DeckCard[];
  commander?: string;
  hearts: number;
  isCommunity: boolean;
  updatedAt?: string;
}

export interface User {
  username: string;
}

export interface CommunityDeckResult {
  id: string;
  name: string;
  username: string;
  commander?: string;
  commanderOracleId?: string;
  hearts: number;
}

export interface CommunityDeckDetail {
  name: string;
  username: string;
  commander?: string;
  hearts: number;
  cards: DeckCard[];
}

export interface TopDecksResponse {
  decks: CommunityDeckResult[];
  total: number;
  page: number;
  limit: number;
}