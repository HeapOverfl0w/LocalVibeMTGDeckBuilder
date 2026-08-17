export interface CardResult {
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
}

export interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
  manaCost?: string;
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