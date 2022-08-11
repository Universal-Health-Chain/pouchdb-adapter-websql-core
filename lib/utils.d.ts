declare function escapeBlob(str: string): string;
declare function unescapeBlob(str: string): string;
declare function stringifyDoc(doc: any): string;
declare function unstringifyDoc(stringifiedDoc: string, id: string, rev: string): any;
declare function qMarks(num: number): string;
declare function select(selector: string, table: any, joiner: any, where: any | null, orderBy: string | undefined): string;
declare function compactRevs(revs: any[], docId: any, tx: {
    executeSql: (arg0: string, arg1: any[], arg2: {
        (tx: any, res: any): void;
        (tx: any, res: any): void;
    }) => void;
}): void;
declare function websqlError(callback: (arg0: any) => void): (event: {
    constructor: {
        toString: () => string;
    };
    type: any;
    target: any;
    message: any;
}) => void;
declare function getSize(opts: {
    size: number;
}): number;
export { escapeBlob, unescapeBlob, stringifyDoc, unstringifyDoc, qMarks, select, compactRevs, getSize, websqlError };
