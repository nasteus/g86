package com.motog86.webnode;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Scanner;

public class ProcessHelper {
    private static final String TAG = "ProcessHelper";

    public interface LogCallback {
        void onLog(String line);
    }

    public static void copyAssetFolder(Context context, String assetPath, File destDir) throws IOException {
        if (!destDir.exists()) {
            destDir.mkdirs();
        }

        String[] files = context.getAssets().list(assetPath);
        if (files == null || files.length == 0) {
            // It's a file
            copyAssetFile(context, assetPath, destDir);
            return;
        }

        for (String file : files) {
            String subAsset = assetPath.isEmpty() ? file : assetPath + "/" + file;
            File subDest = new File(destDir, file);

            String[] subFiles = context.getAssets().list(subAsset);
            if (subFiles != null && subFiles.length > 0) {
                copyAssetFolder(context, subAsset, subDest);
            } else {
                copyAssetFile(context, subAsset, subDest);
            }
        }
    }

    private static void copyAssetFile(Context context, String assetPath, File destFile) throws IOException {
        try (InputStream in = context.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(destFile)) {
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) != -1) {
                out.write(buf, 0, read);
            }
        }
    }

    public static File getExecutable(Context context, String libName) {
        String nativeDir = context.getApplicationInfo().nativeLibraryDir;
        File file = new File(nativeDir, libName);
        if (file.exists()) {
            file.setExecutable(true, false);
            return file;
        }
        return null;
    }

    public static boolean isValidSqliteDb(File file) {
        if (file == null || !file.exists() || file.length() < 100) return false;
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] header = new byte[16];
            int read = in.read(header);
            if (read < 16) return false;
            String magic = new String(header, java.nio.charset.StandardCharsets.US_ASCII);
            return magic.startsWith("SQLite format 3");
        } catch (Exception e) {
            return false;
        }
    }

    public static File getG86StorageDir(Context context) {
        File g86Dir = new File(android.os.Environment.getExternalStorageDirectory(), "g86");
        if (!g86Dir.exists()) {
            boolean created = g86Dir.mkdirs();
            if (!created && !g86Dir.exists()) {
                return new File(context.getFilesDir(), "g86");
            }
        }
        return g86Dir;
    }

    public static void copyFileOrFolder(File src, File dest) throws IOException {
        if (src.isDirectory()) {
            if (!dest.exists()) dest.mkdirs();
            String[] children = src.list();
            if (children != null) {
                for (String child : children) {
                    copyFileOrFolder(new File(src, child), new File(dest, child));
                }
            }
        } else {
            try (InputStream in = new java.io.FileInputStream(src);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                }
            }
        }
    }

    public static File createTorConfig(Context context, int httpPort) throws IOException {
        File filesDir = context.getFilesDir();
        File torData = new File(filesDir, "tor_data");
        File hsDir = new File(torData, "hs");
        if (!hsDir.exists()) {
            hsDir.mkdirs();
        }

        // Restaureaza cheile Tor din memoria externa /sdcard/g86/tor_data/hs daca exista
        File extHsDir = new File(getG86StorageDir(context), "tor_data/hs");
        if (extHsDir.exists()) {
            File extHostname = new File(extHsDir, "hostname");
            File intHostname = new File(hsDir, "hostname");
            if (extHostname.exists() && !intHostname.exists()) {
                try {
                    copyFileOrFolder(extHsDir, hsDir);
                } catch (Exception ignored) {}
            }
        }

        File torrc = new File(filesDir, "torrc");
        try (FileWriter writer = new FileWriter(torrc)) {
            writer.write("DataDirectory " + torData.getAbsolutePath() + "\n");
            writer.write("SocksPort 9050\n");
            writer.write("Log notice file " + torData.getAbsolutePath() + "/tor.log\n");
            writer.write("HiddenServiceDir " + hsDir.getAbsolutePath() + "\n");
            writer.write("HiddenServicePort 80 127.0.0.1:" + httpPort + "\n");
            writer.flush();
        }
        return torrc;
    }

    public static Process startProcess(String[] cmd, File workingDir, LogCallback callback) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        if (workingDir != null) {
            pb.directory(workingDir);
        }
        pb.redirectErrorStream(true);
        Process process = pb.start();

        new Thread(() -> {
            try (Scanner scanner = new Scanner(process.getInputStream())) {
                while (scanner.hasNextLine()) {
                    String line = scanner.nextLine();
                    if (callback != null) {
                        callback.onLog(line);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Process reader stopped", e);
            }
        }).start();

        return process;
    }

    public static class ActiveClient {
        public String ip;
        public String type;
        public String email; // null if guest
    }

    public static List<ActiveClient> getActiveClients(Context context) {
        Map<String, ActiveClient> clientMap = new LinkedHashMap<>();

        File auxDbFile = new File(context.getFilesDir(), "pb_data/auxiliary.db");
        if (!auxDbFile.exists()) {
            auxDbFile = new File(getG86StorageDir(context), "pb_data/auxiliary.db");
        }
        File dataDbFile = new File(context.getFilesDir(), "pb_data/data.db");
        if (!dataDbFile.exists()) {
            dataDbFile = new File(getG86StorageDir(context), "pb_data/data.db");
        }

        if (auxDbFile.exists()) {
            SQLiteDatabase auxDb = null;
            try {
                auxDb = SQLiteDatabase.openDatabase(
                        auxDbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY
                );
                long nowMs = System.currentTimeMillis();
                java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS'Z'", java.util.Locale.US);
                sdf.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
                java.text.SimpleDateFormat sdfAlt = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
                sdfAlt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));

                try (Cursor cursor = auxDb.rawQuery(
                        "SELECT data, created FROM _logs ORDER BY rowid DESC LIMIT 300", null
                )) {
                    while (cursor.moveToNext()) {
                        String json = cursor.getString(0);
                        String createdStr = cursor.getString(1);
                        if (json == null || json.isEmpty()) continue;

                        long createdMs = 0;
                        try {
                            if (createdStr != null) createdMs = sdf.parse(createdStr).getTime();
                        } catch (Exception e) {
                            try {
                                if (createdStr != null) createdMs = sdfAlt.parse(createdStr).getTime();
                            } catch (Exception ignored) {}
                        }

                        // Consider client active if activity is within last 120 seconds
                        if (createdMs > 0 && (nowMs - createdMs) > 120000) {
                            continue;
                        }

                        String ip = extractJsonField(json, "userIP");
                        if (ip == null || ip.isEmpty()) {
                            ip = extractJsonField(json, "remoteIP");
                        }

                        String url = extractJsonField(json, "url");
                        String emailFromUrl = extractEmailFromUrl(url);

                        boolean isCloudflare = false;
                        String referer = extractJsonField(json, "referer");
                        if (referer != null && referer.contains("trycloudflare.com")) {
                            isCloudflare = true;
                        }

                        if ("127.0.0.1".equals(ip) || "::1".equals(ip) || ip == null || ip.isEmpty()) {
                            if (isCloudflare) {
                                ip = "Cloudflare Tunnel (HTTPS)";
                            } else {
                                continue;
                            }
                        }

                        // Key by email or IP so multiple users never overwrite each other
                        String clientKey = (emailFromUrl != null && !emailFromUrl.isEmpty()) ? emailFromUrl : ip;
                        ActiveClient client = clientMap.get(clientKey);
                        if (client == null) {
                            client = new ActiveClient();
                            client.ip = ip;
                            if (isCloudflare) {
                                client.type = "Tunel Cloudflare (Extern)";
                            } else if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
                                client.type = "Rețea Locală (Wi-Fi)";
                            } else {
                                client.type = "Conexiune Externă";
                            }
                            clientMap.put(clientKey, client);
                        }

                        // Check URL for email parameter or auth collection
                        if (client.email == null || client.email.isEmpty()) {
                            if (emailFromUrl != null && !emailFromUrl.isEmpty()) {
                                client.email = emailFromUrl;
                            } else {
                                String authVal = extractJsonField(json, "auth");
                                if ("users".equalsIgnoreCase(authVal)) {
                                    client.email = resolveLatestEmail(dataDbFile);
                                }
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Eroare la citirea clientilor activi", e);
            } finally {
                if (auxDb != null) {
                    try { auxDb.close(); } catch (Exception ignored) {}
                }
            }
        }

        return new ArrayList<>(clientMap.values());
    }

    private static String extractEmailFromUrl(String url) {
        if (url == null) return null;
        int idx = url.indexOf("email=");
        if (idx == -1) idx = url.indexOf("u=");
        if (idx != -1) {
            int start = url.indexOf("=", idx) + 1;
            int end = url.indexOf("&", start);
            String enc = (end != -1) ? url.substring(start, end) : url.substring(start);
            try {
                String decoded = java.net.URLDecoder.decode(enc, "UTF-8").trim();
                if (decoded.contains("@")) return decoded;
            } catch (Exception ignored) {}
        }
        return null;
    }

    private static String extractJsonField(String json, String field) {
        String pattern = "\"" + field + "\":\"";
        int idx = json.indexOf(pattern);
        if (idx == -1) return null;
        int start = idx + pattern.length();
        int end = json.indexOf("\"", start);
        if (end > start) {
            String val = json.substring(start, end).trim();
            if (!val.isEmpty() && !"guest".equalsIgnoreCase(val)) {
                return val;
            }
        }
        return null;
    }

    private static String resolveLatestEmail(File dataDbFile) {
        if (!dataDbFile.exists()) return null;
        SQLiteDatabase dataDb = null;
        try {
            dataDb = SQLiteDatabase.openDatabase(
                    dataDbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY
            );
            try (Cursor cursor = dataDb.rawQuery(
                    "SELECT email FROM users ORDER BY created DESC LIMIT 1", null
            )) {
                if (cursor.moveToNext()) {
                    return cursor.getString(0);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (dataDb != null) {
                try { dataDb.close(); } catch (Exception ignored) {}
            }
        }
        return null;
    }
}
