import { getReadlaterSettings } from 'src/main';
import { App, htmlToMarkdown, normalizePath, requestUrl, TFile } from "obsidian";

import Server from "http-proxy";
import { ClientRequest, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
// import {JSDOM} from "jsdom";
import {DOMParser, parseHTML} from 'linkedom';
import path from 'path';

const PROXY_PORT = 54800;

export default class Processor {
    app: App;
    static fileNameRE = /[\\/:]/gm;
    // static _proxies: Map<Server,number> = new Map();
    static _ports: Map<number, boolean> = new Map();
    /**
     *
     */
    constructor(app: App) {
        this.app = app;
        
    }

    _proxy: Server | undefined;
    _port: number;

    async processFile(file: TFile) {
        const metaData = app.metadataCache.getFileCache(file);
        const frontMatter = metaData?.frontmatter;
        const attr = getReadlaterSettings().urlAttribute;

        const syncUrl = frontMatter?.[attr];

        if (syncUrl) {
            const [title, md] = await this.downloadAsMarkDown(syncUrl);
            const content: string = await this.app.vault.cachedRead(file);
            const newContent =
                content.substring(0, frontMatter.position.end.offset) +
                "\n" +
                md;
            app.vault.modify(file, newContent);
            app.vault.rename(file,title);
        }
    }


    async createFileFromURL(url: string){
        const [title, md] = await this.downloadAsMarkDown(url);
        const attr = getReadlaterSettings().urlAttribute;
        const content = `---\n${attr}: "${url}"\n---\n`+md;
        const fileName = this.normalizeFileName(title)+".md";
        let folder = getReadlaterSettings().readLaterFolder;
        if(!folder){
            folder = this.app.workspace.getActiveFile()?.path || "/";
        }
        const fullPath = normalizePath(path.join(folder, fileName));
        const file = await this.app.vault.create(fullPath,content);
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
    }

    // https://pratikpc.medium.com/bypassing-cors-with-electron-ab7eaf331605
    // https://gist.github.com/jesperorb/6ca596217c8dfba237744966c2b5ab1e
    // https://dhanrajsp.me/blog/the-tale-of-bypassing-cors
    // https://www.npmjs.com/package/http-proxy#using-https
    async downloadAsMarkDown(syncUrl: string) {
        const url = new URL(syncUrl);

        // this.createProxy(url.origin);

        let md = "";
        let title = "";
        try {
            // const tmp = process.env.NODE_TLS_REJECT_UNAUTHORIZED
            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

            // const resp = await fetch(
            //     `http://localhost:${this._port}/${url.pathname}${url.search}`,
            //     {
            //         method: "GET",
            //         // mode: "no-cors",
            //         headers: {
            //             "Content-Type": "text/html",
            //         },
            //     }
            // );
            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = tmp;

            const resp = await requestUrl({
                url: syncUrl,
                method: "GET",
                headers: {
                    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36 Edg/105.0.1343.50",
                    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                    "cookie": ""
                }
                
            })

            const html = resp.text;
            let article;
            [title, article] = this.extractData(html);
            md = htmlToMarkdown(article);
        } catch (error) {
            console.warn(error);
        } finally {
            // this.closeProxy();
        }
        return [title, md];
    }

    async downloadAsMarkDownUsingProxy(syncUrl: string) {
        const url = new URL(syncUrl);

        this.createProxy(url.origin);

        let md = "";
        let title = "";
        try {
            // const tmp = process.env.NODE_TLS_REJECT_UNAUTHORIZED
            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

            const resp = await fetch(
                `http://localhost:${this._port}/${url.pathname}${url.search}`,
                {
                    method: "GET",
                    // mode: "no-cors",
                    headers: {
                        "Content-Type": "text/html",
                    },
                }
            );
            // process.env.NODE_TLS_REJECT_UNAUTHORIZED = tmp;

            

            const html = await resp.text();
            let article;
            [title, article] = this.extractData(html);
            md = htmlToMarkdown(article);
        } catch (error) {
            console.warn(error);
        } finally {
            this.closeProxy();
        }
        return [title, md];
    }

    extractData(html: string){
        const dom = parseHTML(html);
        // const dom = new JSDOM(html);
        const title = dom.window.document.title;
        let article = dom.window.document.querySelector("article");
        if(!article){
            article = dom.window.document.body;
        } 
        return [title, article.outerHTML]
    }

    closeProxy() {
        this._proxy && this._proxy.close();
        Processor._ports.delete(this._port);
        this._proxy = undefined;
    }

    createProxy(server: string) {
        if (this._proxy) {
            this._proxy.close();
        } else {
            let p = PROXY_PORT;
            while (Processor._ports.has(p)) {
                p++;
            }
            this._port = p;
            Processor._ports.set(p,true);
        }
        this._proxy = Server.createProxyServer({
            target: server,
            secure: false,
            changeOrigin: true,
            followRedirects: true,
        }).listen(this._port);

        this._proxy.on(
            "proxyRes",
            function (
                proxyRes: IncomingMessage,
                req: IncomingMessage,
                res: ServerResponse
            ) {
                enableCors(proxyRes, req, res);
            }
        );

        this._proxy.on(
            "proxyReq",
            (
                proxyReq: ClientRequest,
                req: IncomingMessage,
                res: ServerResponse
            ) => {

                proxyReq.removeHeader("cookie")
            }
        );
    }

    private normalizeFileName(title: string){
        const result = title.replace(Processor.fileNameRE, "");
        return result;
    }
}

const enableCors = (
    proxyRes: IncomingMessage,
    req: IncomingMessage,
    res: ServerResponse
) => {
    if (req.headers["access-control-request-method"]) {
        res.setHeader(
            "access-control-allow-methods",
            req.headers["access-control-request-method"]
        );
    }

    if (req.headers["access-control-request-headers"]) {
        res.setHeader(
            "access-control-allow-headers",
            req.headers["access-control-request-headers"]
        );
    }

    if (req.headers.origin) {
        res.setHeader("access-control-allow-origin", req.headers.origin);
        res.setHeader("access-control-allow-credentials", "true");
    }
    if (req.method === "OPTIONS") {
        res.statusCode = 200;
        proxyRes.statusCode = 200;
    }

};
