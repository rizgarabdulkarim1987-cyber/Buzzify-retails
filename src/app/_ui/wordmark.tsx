/**
 * The product wordmark: the brand in Latin letters (isolated, so it never reorders inside Arabic or
 * Kurdish text) followed by the product word in the UI language, e.g. "Buzzify Supermarket".
 */
export function Wordmark({ brand, word, className }: { brand: string; word: string; className?: string }) {
  return (
    <span className={className ? `wordmark ${className}` : "wordmark"} data-testid="wordmark">
      <bdi dir="ltr">{brand}</bdi> <span>{word}</span>
    </span>
  );
}
