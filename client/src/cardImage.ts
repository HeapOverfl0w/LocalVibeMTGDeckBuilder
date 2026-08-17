export async function getCardImageUrl(scryfallOracleId: string): Promise<string> {
  if (!scryfallOracleId) return '';
  
  try {
    const response = await fetch(`https://api.scryfall.com/cards/search?q=oracle_id:${scryfallOracleId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch card data');
    }
    const data = await response.json();
    const card = data.data?.[0];
    let imageUrl = "";

    if (card?.image_uris) {
      // Single-faced card
      imageUrl = card.image_uris.normal;
    } else if (card?.card_faces && card.card_faces[0]?.image_uris) {
      // Double-faced card (grab the front face)
      imageUrl = card.card_faces[0].image_uris.normal;
    }
    
    if (imageUrl) {
      return imageUrl;
    }
    
    // Fallback to direct CDN URL
    const char1 = scryfallOracleId.charAt(0);
    const char2 = scryfallOracleId.charAt(1);
    return `https://cards.scryfall.io/png/front/${char1}/${char2}/${scryfallOracleId}.png`;
  } catch (error) {
    // Fallback to direct CDN URL
    const char1 = scryfallOracleId.charAt(0);
    const char2 = scryfallOracleId.charAt(1);
    return `https://cards.scryfall.io/png/front/${char1}/${char2}/${scryfallOracleId}.png`;
  }
}