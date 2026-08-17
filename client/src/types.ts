export interface CardResult {
  name: string;
  scryfallOracleId: string;
}

export interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
}

export interface Deck {
  id: string;
  name: string;
  cards: DeckCard[];
  updatedAt?: string;
}

export interface User {
  username: string;
}