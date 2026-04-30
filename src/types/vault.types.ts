export interface VaultDir {
	name: string;
	dir: string;
	default: boolean;
}

export type VaultDirsArray = readonly VaultDir[];
