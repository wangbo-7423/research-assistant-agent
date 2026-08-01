import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from '@nestjs/common';

export class MyLogger implements LoggerService {
    private logDir = path.resolve(__dirname, '../logs'); // 日志文件夹
    
    constructor() {
        // 如果日志目录不存在则创建
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    private writeLog(level: string, message: any) {
        const logFile = path.join(this.logDir, `${level}.log`);
        const logMsg = `[${new Date().toISOString()}] [${level}] ${message}\n`;
        fs.appendFile(logFile, logMsg, (err) => {
            if (err) {
                console.error("Error writing log file:", err);
            }
        })
    }

    log(message: any) {
        console.log("[LOG]", message);
        this.writeLog("log", message);
    }

    error(message: any, trace?: string) {
        console.error("[ERROR]", message, trace ? `\n${trace}` : "");
        this.writeLog("error", `${message}${trace ? '\n' + trace : ''}`);
    }

    warn(message: any) {
        console.warn("[WARN]", message);
        this.writeLog("warn", message);
    }

    debug(message: any) {
        console.debug("[DEBUG]", message);
        this.writeLog("debug", message);
    }
    
    verbose(message: any) {
        console.log("[VERBOSE]", message);
        this.writeLog("verbose", message);
    }
}