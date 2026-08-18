export interface CardResult {
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
  type?: string;
}

export interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
  manaCost?: string;
  type?: string;
}

export interface Deck {
  id: string;
  name: string;
  cards: DeckCard[];
  commander?: string;
  updatedAt?: string;
}

export interface User {
  username: string;
}