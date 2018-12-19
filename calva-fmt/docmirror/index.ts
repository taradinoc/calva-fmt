import * as vscode from "vscode";
import { Scanner, ScannerState, Token } from "./clojure-lexer";

const scanner = new Scanner();

class ClojureSourceLine {
    tokens: Token[];
    endState: ScannerState;
    constructor(public text: string, public startState: ScannerState, lineNo: number) {
        this.tokens = scanner.processLine(text, lineNo, startState)
        this.endState = scanner.state;
    }

    get length() {
        return this.text.length;
    }
}

let debugValidation = false

/** A mutable cursor into the token stream. */
class TokenCursor {
    constructor(public doc: DocumentMirror, public line: number, public token: number, public deltaDepth = 0) {
    }

    /** Create a copy of this cursor. */
    clone() {
        return new TokenCursor(this.doc, this.line, this.token, this.deltaDepth);
    }

    /** Return the start position */
    get start() {
        return new vscode.Position(this.line, this.getToken().offset);
    }

    /** Return the end position */
    get end() {
        return new vscode.Position(this.line, this.getToken().offset + this.getToken().raw.length);
    }

    /** True if we are at the start of the document */
    atStart() {
        return this.token == 0 && this.line == 0;
    }

    /** True if we are at the end of the document */
    atEnd() {
        return this.line == this.doc.lines.length-1 && this.token == this.doc.lines[this.line].tokens.length-1;
    }

    /** Move this cursor backwards one token */
    previous() {
        if(this.token > 0) {
            this.token--;
        } else {
            if(this.line == 0) return;
            this.line--;
            this.token = this.doc.lines[this.line].tokens.length-1;
        }
        const tk = this.getToken()
        if(tk.type == "open")
            this.deltaDepth--;
        else if(tk.type == "close")
            this.deltaDepth++;
        return this;
    }

    /** Move this cursor forwards one token */
    next() {
        if(this.token < this.doc.lines[this.line].tokens.length-1) {
            this.token++;
        } else {
            if(this.line == this.doc.lines.length-1) return;
            this.line++;
            this.token = 0;
        }
        const tk = this.getToken();
        if(tk.type == "open")
            this.deltaDepth++;
        else if(tk.type == "close")
            this.deltaDepth--;
        return this;
    }

    findPrev(type: string, depth: number = 0) {
        depth += this.deltaDepth;
        while(!this.atStart()) {
            this.previous();
            const tk = this.getToken();
            if(tk.type == type && this.deltaDepth == depth)
                return this;
        }
        return this;
    }

    findNext(type: string, depth: number = 0) {
        depth += this.deltaDepth;
        while(!this.atEnd()) {
            this.next();
            const tk = this.getToken();
            if(tk.type == type && this.deltaDepth == depth)
                return this;
        }
        return this;
    }

    getToken() {
        return this.doc.lines[this.line].tokens[this.token];
    }
}

function equal(x: any, y: any): boolean {
    if(x==y) return true;
    if(x instanceof Array && y instanceof Array) {
        if(x.length == y.length) {
            for(let i = 0; i<x.length; i++)
                if(!equal(x[i], y[i]))
                    return false;
            return true;
        } else
            return false;
    } else if (!(x instanceof Array) && !(y instanceof Array) && x instanceof Object && y instanceof Object) {
        for(let f in x)
            if(!equal(x[f], y[f]))
                return false;
        for(let f in y)
            if(!x.hasOwnProperty(f))
                return false
        return true;
    }
    return false;
}

class DocumentMirror {
    lines: ClojureSourceLine[] = [];
    scanner = new Scanner();

    dirtyLines: number[] = [];

    constructor(public doc: vscode.TextDocument) {
        scanner.state = this.getStateForLine(0);
        for(let i=0; i<doc.lineCount; i++) {
            let line = doc.lineAt(i);
            this.lines.push(new ClojureSourceLine(line.text, scanner.state, i));
        }
    }

    rescanAll() {
        scanner.state = this.getStateForLine(0);
        this.lines = [];
        let now = Date.now();
        for(let i=0; i<this.doc.lineCount; i++) {
            let line = this.doc.lineAt(i);
            this.lines.push(new ClojureSourceLine(line.text, scanner.state, i));
        }
        console.log("Rescanned document in "+(Date.now()-now)+"ms");
    }

    private markDirty(idx: number) {
        if(idx >= 0 && idx < this.lines.length)
        if(this.dirtyLines.indexOf(idx) == -1)
            this.dirtyLines.push(idx);
    }

    private removeDirty(start: number, end: number, inserted: number) {
        let delta = end-start + inserted;
        this.dirtyLines = this.dirtyLines.filter(x => x < start || x > end)
                                          .map(x => x > start ? x - delta : x);
    }
    
    private getStateForLine(line: number): ScannerState {
        return line == 0 ? { inString: false, } : { ... this.lines[line-1].endState };
    }

    public getTokenCursor(pos: vscode.Position, previous: boolean = false) {
        this.flushChanges();
        let line = this.lines[pos.line]
        let lastIndex = 0;
        if(line) {
            for(let i=0; i<line.tokens.length; i++) {
                let tk = line.tokens[i];
                if(previous ? tk.offset > pos.character : tk.offset >= pos.character)
                    return new TokenCursor(this, pos.line, previous ? Math.max(0, lastIndex-1) : lastIndex);
                lastIndex = i;
            }
            return new TokenCursor(this, pos.line, line.tokens.length-1);
        }
    }

    private changeRange(e: vscode.TextDocumentContentChangeEvent) {
        // extract the lines we will replace
        let replaceLines = e.text.split(this.doc.eol == vscode.EndOfLine.LF ? /\n/ : /\r\n/);

        // the left side of the line unaffected by the edit.
        let left = this.lines[e.range.start.line].text.substr(0, e.range.start.character);

        // the right side of the line unaffected by the edit.
        let right = this.lines[e.range.end.line].text.substr(e.range.end.character);

        // we've nuked this lines, so. yay.
        this.removeDirty(e.range.start.line, e.range.end.line, replaceLines.length-1);

        let items: ClojureSourceLine[] = [];
        
        // initialize the lexer state - the first line is definitely not in a string, otherwise copy the
        // end state of the previous line before the edit
        let state = this.getStateForLine(e.range.start.line)

        if(replaceLines.length == 1) {
            // trivial single line edit
            items.push(new ClojureSourceLine(left + replaceLines[0] + right, state, e.range.start.line));
        } else {
            // multi line edit.
            items.push(new ClojureSourceLine(left + replaceLines[0], state, e.range.start.line));
            for(let i=1; i<replaceLines.length-1; i++)
                items.push(new ClojureSourceLine(replaceLines[i], scanner.state, e.range.start.line+i));
            items.push(new ClojureSourceLine(replaceLines[replaceLines.length-1] + right, scanner.state, e.range.start.line+replaceLines.length))
        }

        // now splice in our edited lines
        this.lines.splice(e.range.start.line, e.range.end.line-e.range.start.line+1, ...items);
        let nextIdx = e.range.start.line
        this.markDirty(nextIdx+1);
    }

    flushChanges() {
        if(!this.dirtyLines.length)
            return;
        let seen = new Set<number>();
        this.dirtyLines.sort();
        while(this.dirtyLines.length) {
            let nextIdx = this.dirtyLines.shift();
            if(seen.has(nextIdx))
                continue; // already processed.
            seen.add(nextIdx);
            let prevState = this.getStateForLine(nextIdx);
            let newLine: ClojureSourceLine;
            do {
                seen.add(nextIdx);
                newLine = new ClojureSourceLine(this.lines[nextIdx].text, prevState, nextIdx);
                prevState = newLine.endState;
                this.lines[nextIdx] = newLine;    
            } while(this.lines[++nextIdx] && !(equal(this.lines[nextIdx].startState, prevState)))
        }
    }

    processChanges(e: vscode.TextDocumentContentChangeEvent[]) {
        for(let change of e)
            this.changeRange(change);
        this.flushChanges();
        
        if(debugValidation && this.doc.getText() != this.text)
            vscode.window.showErrorMessage("DocumentMirror failed");
    }

    get text() {
        return this.lines.map(x => x.text).join(this.doc.eol == vscode.EndOfLine.LF ? "\n" : "\r\n");
    }
}

let documents = new Map<vscode.TextDocument, DocumentMirror>();

let registered = false;
export function activate() {
    // the last thing we want is to register twice and receive double events...
    if(registered)
        return;
    registered = true;

    vscode.workspace.onDidCloseTextDocument(e => {
        if(e.languageId == "clojure") {
            documents.delete(e);
        }
    })

    vscode.workspace.onDidChangeTextDocument(e => {
        if(e.document.languageId == "clojure") {
            if(!documents.get(e.document))
                documents.set(e.document, new DocumentMirror(e.document));
            else
                documents.get(e.document).processChanges(e.contentChanges)
        }
    })
}

export function getDocument(doc: vscode.TextDocument) {
    if(doc.languageId == "clojure") {
        if(!documents.get(doc))
            documents.set(doc, new DocumentMirror(doc));
        return documents.get(doc);
    }
}

/**
 * Temporary formatting commands
 * 
 * These won't live here.
 */
export function growSelection() {
    let doc = vscode.window.activeTextEditor.document
    let mirror = getDocument(doc);
    if(mirror) {
        try {
            vscode.window.activeTextEditor.selection = new vscode.Selection(
                mirror.getTokenCursor(vscode.window.activeTextEditor.selection.start).findPrev("open", -1).start,
                mirror.getTokenCursor(vscode.window.activeTextEditor.selection.end).findNext("close", -1).end)
        } catch (e) {
            console.error(e);
        }
    }
}