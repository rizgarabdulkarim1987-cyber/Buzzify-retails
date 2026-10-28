import type { ar } from "./ar";

type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };

/** The shape every locale must have (the Arabic keys, every leaf a string). */
export type Messages = Strings<typeof ar>;
