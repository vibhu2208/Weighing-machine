using MyReaderAPI;
using MyReaderAPI.MyInterface;
using MyReaderAPI.Models;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;

namespace RfidBridge
{
    internal sealed class Program : IAsynchronousMessage
    {
        private static readonly object WriteLock = new object();
        private string _connId = "";
        private bool _running = true;

        private static void Main(string[] args)
        {
            var bridge = new Program();
            bridge.Run();
        }

        private void Run()
        {
            Emit("ready", null);

            string line;
            while (_running && (line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                try
                {
                    HandleCommand(line.Trim());
                }
                catch (Exception ex)
                {
                    EmitError(ex.Message);
                }
            }
        }

        private void HandleCommand(string line)
        {
            var cmd = JsonHelper.ParseObject(line);
            if (!cmd.TryGetValue("cmd", out var action) || string.IsNullOrEmpty(action))
            {
                EmitError("Missing cmd field");
                return;
            }

            switch (action.ToLowerInvariant())
            {
                case "connect":
                    HandleConnect(cmd);
                    break;
                case "startinventory":
                    HandleStartInventory(cmd);
                    break;
                case "stop":
                    HandleStop();
                    break;
                case "disconnect":
                    HandleDisconnect();
                    break;
                case "getreaderproperty":
                    HandleGetReaderProperty();
                    break;
                case "getpower":
                    HandleGetPower();
                    break;
                case "setpower":
                    HandleSetPower(cmd);
                    break;
                case "ping":
                    Emit("pong", null);
                    break;
                case "quit":
                    HandleDisconnect();
                    _running = false;
                    break;
                default:
                    EmitError("Unknown cmd: " + action);
                    break;
            }
        }

        private void HandleConnect(Dictionary<string, string> cmd)
        {
            if (!cmd.TryGetValue("ip", out var ip) || string.IsNullOrEmpty(ip))
            {
                EmitError("Missing ip");
                return;
            }

            if (!cmd.TryGetValue("port", out var portStr) || string.IsNullOrEmpty(portStr))
            {
                portStr = "9090";
            }

            if (!string.IsNullOrEmpty(_connId))
            {
                HandleDisconnect();
            }

            _connId = ip + ":" + portStr;

            if (MyReader.CreateTcpConn(_connId, this))
            {
                Emit("connected", new Dictionary<string, object>
                {
                    { "connId", _connId }
                });
            }
            else
            {
                EmitError("TCP connect failed for " + _connId);
            }
        }

        private void HandleStartInventory(Dictionary<string, string> cmd)
        {
            if (string.IsNullOrEmpty(_connId))
            {
                EmitError("Not connected");
                return;
            }

            int antMask = 1;
            if (cmd.TryGetValue("antMask", out var antMaskStr))
            {
                int.TryParse(antMaskStr, out antMask);
            }

            eReadType readType = eReadType.Inventory;
            if (cmd.TryGetValue("readType", out var readTypeStr) &&
                readTypeStr.Equals("single", StringComparison.OrdinalIgnoreCase))
            {
                readType = eReadType.Single;
            }

            eAntennaNo antNum = MaskToAntenna(antMask);

            try
            {
                MyReader._Config.Stop(_connId);
            }
            catch
            {
                /* reader may not be scanning yet */
            }

            Thread.Sleep(150);

            int result = MyReader._Tag6C.GetEPC(_connId, antNum, readType);
            if (result == 0)
            {
                Emit("inventoryStarted", new Dictionary<string, object>
                {
                    { "antMask", antMask },
                    { "readType", readType == eReadType.Inventory ? "inventory" : "single" }
                });
            }
            else
            {
                EmitError("GetEPC failed with code " + result);
            }
        }

        private void HandleStop()
        {
            if (string.IsNullOrEmpty(_connId)) return;

            int result = MyReader._Config.Stop(_connId);
            Emit("stopped", new Dictionary<string, object>
            {
                { "code", result }
            });
        }

        private void HandleGetReaderProperty()
        {
            if (string.IsNullOrEmpty(_connId))
            {
                EmitError("Not connected");
                return;
            }

            try
            {
                string result = MyReader._Config.GetReaderProperty(_connId);
                int minPower = 5;
                int maxPower = 30;

                if (!string.IsNullOrEmpty(result))
                {
                    var parts = result.Split('|');
                    if (parts.Length >= 1) int.TryParse(parts[0].Trim(), out minPower);
                    if (parts.Length >= 2) int.TryParse(parts[1].Trim(), out maxPower);
                }

                Emit("readerProperty", new Dictionary<string, object>
                {
                    { "minPower", minPower },
                    { "maxPower", maxPower },
                    { "raw", result ?? "" }
                });
            }
            catch (Exception ex)
            {
                EmitError("GetReaderProperty failed: " + ex.Message);
            }
        }

        private void HandleGetPower()
        {
            if (string.IsNullOrEmpty(_connId))
            {
                EmitError("Not connected");
                return;
            }

            try
            {
                Dictionary<Int32, Int32> antPower = MyReader._Config.GetANTPowerParam(_connId);
                var sb = new System.Text.StringBuilder();
                if (antPower != null)
                {
                    bool first = true;
                    foreach (var kv in antPower)
                    {
                        if (!first) sb.Append(',');
                        sb.Append(kv.Key).Append(':').Append(kv.Value);
                        first = false;
                    }
                }

                Emit("power", new Dictionary<string, object>
                {
                    { "powers", sb.ToString() }
                });
            }
            catch (Exception ex)
            {
                EmitError("GetANTPowerParam failed: " + ex.Message);
            }
        }

        private void HandleSetPower(Dictionary<string, string> cmd)
        {
            if (string.IsNullOrEmpty(_connId))
            {
                EmitError("Not connected");
                return;
            }

            var antPower = new Dictionary<Int32, Int32>();

            if (cmd.TryGetValue("powerMap", out var powerMap) && !string.IsNullOrEmpty(powerMap))
            {
                foreach (var pair in powerMap.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var kv = pair.Split(':');
                    if (kv.Length != 2) continue;
                    if (int.TryParse(kv[0].Trim(), out var ant) && int.TryParse(kv[1].Trim(), out var pwr))
                    {
                        antPower[ant] = pwr;
                    }
                }
            }
            else if (cmd.TryGetValue("antenna", out var antStr) &&
                     cmd.TryGetValue("power", out var pwrStr) &&
                     int.TryParse(antStr, out var antNum) &&
                     int.TryParse(pwrStr, out var powerDb))
            {
                antPower[antNum] = powerDb;
            }

            if (antPower.Count == 0)
            {
                EmitError("Missing antenna/power or powerMap");
                return;
            }

            try
            {
                int result = MyReader._Config.SetANTPowerParam(_connId, antPower);
                if (result == 0)
                {
                    var sb = new System.Text.StringBuilder();
                    bool first = true;
                    foreach (var kv in antPower)
                    {
                        if (!first) sb.Append(',');
                        sb.Append(kv.Key).Append(':').Append(kv.Value);
                        first = false;
                    }

                    Emit("powerSet", new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "powers", sb.ToString() }
                    });
                }
                else
                {
                    EmitError("SetANTPowerParam failed with code " + result);
                }
            }
            catch (Exception ex)
            {
                EmitError("SetANTPowerParam failed: " + ex.Message);
            }
        }

        private void HandleDisconnect()
        {
            if (!string.IsNullOrEmpty(_connId))
            {
                try
                {
                    MyReader._Config.Stop(_connId);
                }
                catch
                {
                    /* ignore */
                }

                try
                {
                    MyReader.CloseConn(_connId);
                }
                catch
                {
                    /* ignore */
                }

                _connId = "";
            }

            Emit("disconnected", null);
        }

        private static eAntennaNo MaskToAntenna(int mask)
        {
            eAntennaNo ant = new eAntennaNo();
            if ((mask & 1) != 0) ant |= eAntennaNo._1;
            if ((mask & 2) != 0) ant |= eAntennaNo._2;
            if ((mask & 4) != 0) ant |= eAntennaNo._3;
            if ((mask & 8) != 0) ant |= eAntennaNo._4;
            if ((mask & 16) != 0) ant |= eAntennaNo._5;
            if ((mask & 32) != 0) ant |= eAntennaNo._6;
            if ((mask & 64) != 0) ant |= eAntennaNo._7;
            if ((mask & 128) != 0) ant |= eAntennaNo._8;
            return ant;
        }

        private static void Emit(string eventName, Dictionary<string, object> fields)
        {
            var json = JsonHelper.BuildEvent(eventName, fields);
            lock (WriteLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        private static void EmitError(string message)
        {
            Emit("error", new Dictionary<string, object> { { "message", message } });
        }

        private static string GetTagProperty(object tag, params string[] names)
        {
            if (tag == null) return "";

            var type = tag.GetType();
            foreach (var name in names)
            {
                var prop = type.GetProperty(name);
                if (prop != null)
                {
                    var val = prop.GetValue(tag, null);
                    if (val != null) return Convert.ToString(val);
                }

                var field = type.GetField(name);
                if (field != null)
                {
                    var val = field.GetValue(tag);
                    if (val != null) return Convert.ToString(val);
                }
            }

            return "";
        }

        public void OutPutTags(Tag_Model tag)
        {
            var fields = new Dictionary<string, object>
            {
                { "epc", GetTagProperty(tag, "EPC", "_EPC") ?? "" },
                { "tid", GetTagProperty(tag, "TID", "_TID") ?? "" },
                { "readerName", GetTagProperty(tag, "ReaderName", "_ReaderName") ?? "" }
            };

            var rssi = GetTagProperty(tag, "RSSI", "_RSSI", "Rssi");
            if (!string.IsNullOrEmpty(rssi)) fields["rssi"] = rssi;

            var antenna = GetTagProperty(tag, "ANT_NUM", "Antenna", "AntNum", "_ANT_NUM");
            if (!string.IsNullOrEmpty(antenna)) fields["antenna"] = antenna;

            Emit("tag", fields);
        }

        public void OutPutTagsOver()
        {
            Emit("inventoryOver", null);
        }

        public void WriteDebugMsg(string msg)
        {
            Emit("debug", new Dictionary<string, object> { { "message", msg ?? "" } });
        }

        public void WriteLog(string msg)
        {
            Emit("log", new Dictionary<string, object> { { "message", msg ?? "" } });
        }

        public void PortConnecting(string connID)
        {
            Emit("portConnecting", new Dictionary<string, object> { { "connId", connID ?? "" } });
        }

        public void PortClosing(string connID)
        {
            Emit("portClosing", new Dictionary<string, object> { { "connId", connID ?? "" } });
        }

        public void GPIControlMsg(int gpiIndex, int gpiState, int startOrStop)
        {
            Emit("gpi", new Dictionary<string, object>
            {
                { "gpiIndex", gpiIndex },
                { "gpiState", gpiState },
                { "startOrStop", startOrStop }
            });
        }
    }
}
