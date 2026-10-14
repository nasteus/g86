package com.motog86.webnode;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
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

    public static File createTorConfig(Context context, int httpPort) throws IOException {
        File filesDir = context.getFilesDir();
        File torData = new File(filesDir, "tor_data");
        File hsDir = new File(torData, "hs");
        if (!hsDir.exists()) {
            hsDir.mkdirs();
        }

        File torrc = new File(filesDir, "torrc");
        try (FileWriter writer = new FileWriter(torrc)) {
            writer.write("DataDirectory " + torData.getAbsolutePath() + "\n");
            writer.write("SocksPort 9050\n"); writer.write("Log notice file " + torData.getAbsolutePath() + "/tor.log\n");
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
}
