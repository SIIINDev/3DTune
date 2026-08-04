# 3DTune — исследование: Kingroon KP5L + desktop-хост

Дата: 2026-08-04. Всё ниже — либо выдержки из реальных файлов прошивок (скачаны и распакованы),
либо из документации Marlin/MKS. Пункты, помеченные **[ПРОВЕРИТЬ]**, требуют подтверждения на живом принтере.

---

## 1. Железо: что такое KP5L изнутри

| Параметр | Значение | Источник |
|---|---|---|
| Плата | MKS Robin Nano V1.x (клон/ревизия Kingroon) | `MOTHERBOARD BOARD_MKS_ROBIN_NANO` в конфиге KP5L |
| MCU | STM32F103VET6 (Cortex-M3, 512 КБ flash, 64 КБ RAM) | PlatformIO env `mks_robin_nano35` |
| Драйверы | TMC2225 (standalone, без UART!) | описание платы Kingroon |
| Экран | TFT, LVGL-UI (`mks_pic`/`mks_font` на SD) в стоке | содержимое стоковых zip |
| Стол | 300×300, Z 330 | `X_MAX_POS 300`, `Y_MAX_POS 300`, `Z_MAX_POS 330` |
| USB | CH340 (USB→UART), **native USB отсутствует** | `#define BOARD_NO_NATIVE_USB` в `pins_MKS_ROBIN_NANO_common.h` |
| Скорость порта | 115200 | `#define BAUDRATE 115200` |

### Карта портов — критично для приложения

Из `Marlin/src/pins/stm32f1/pins_MKS_ROBIN_NANO_common.h`:

```c
#ifndef USB_MOD
  #define BOARD_NO_NATIVE_USB      // стоковый режим: USB идёт через CH340
#endif
#define SERVO0_PIN     PA8          // управление BLTouch
#define Z_MAX_PIN      PC4          // сюда Kingroon велит подключать 3D Touch
#ifndef USB_MOD
  #define Y_STOP_PIN   PA12         // PA11/PA12 (пины USB STM32) заняты эндстопами
  #define Z_MIN_PIN    PA11
#else
  #define Y_STOP_PIN   PB10         // при native-USB моде эндстопы переезжают на пины USART3
  #define Z_MIN_PIN    PB11
#endif
```

Из конфига KP5L:
```c
#define SERIAL_PORT   3    // USART3 (PB10/PB11) → CH340 → USB-разъём. Это наш канал.
#define SERIAL_PORT_2 1    // USART1 (PA9/PA10) → гребёнка WIFI. Свободный второй канал.
```

**Выводы:**
1. Приложение говорит с принтером через **USART3 → CH340 → USB, 115200**. Штатно, без модов.
2. **Тачскрин не занимает UART** — он подключён по FSMC/SPI, а UI скомпилирован внутрь Marlin.
   Значит USB-канал наш целиком, конфликта «экран съел порт» нет.
3. Есть **второй независимый канал** (`SERIAL_PORT_2`, гребёнка WIFI) — резерв на будущее
   (телеметрия параллельно основному каналу, ESP3D, и т.п.).
4. Но: тач-экран — **равноправный источник команд**. Marlin не умеет «блокировать» LCD, пока
   подключён хост. Если крутить настройки и там, и там — получим рассинхрон состояния.
   Отсюда пункт в профиле прошивки: урезать тач-UI до статус-дисплея.

---

## 2. Стоковая прошивка: главное открытие

Скачал официальные стоковые архивы KP5L (зеркало `spinixguy/KP5L-firmware`):

```
KP5L-half assembled-autolevel/         KP5L-half assembled-manual-level/
├── Robin_nano.bin      (416 078 B)    ├── Robin_nano.bin      (416 078 B)
├── robin_nano_cfg.txt  (14 020 B)     ├── robin_nano_cfg.txt  (14 020 B)
├── mks_pic/  (~140 .bin)              ├── mks_pic/
└── mks_font/                          └── mks_font/
```

**Бинарники побайтово идентичны** (`md5 = 57336573e7bc17a0ae6bf18827c685c8`).
Диff конфигов — **одна строка**:

```diff
-  >cfg_leveling_mode 0   # 0: manual leveling
+  >cfg_leveling_mode 1   # 1: automatic leveling
```

То есть «версия с автолевелингом» и «версия без» — это **одна прошивка + один флаг в текстовом файле**.

### Что ещё лежит в `robin_nano_cfg.txt`

Это не UI-конфиг, это **полная конфигурация машины в текстовом виде** (272 строки):

```
>DEFAULT_X_STEPS_PER_UNIT 160      >DEFAULT_Kp 24
>DEFAULT_Y_STEPS_PER_UNIT 160      >DEFAULT_Ki 0.88
>DEFAULT_Z_STEPS_PER_UNIT 800      >DEFAULT_Kd 80
>DEFAULT_E0_STEPS_PER_UNIT 768     >PIDTEMPE 1
                                   >PIDTEMPBED 0          ← стол в bang-bang, НЕ PID!
>DEFAULT_X_MAX_FEEDRATE 300        >HEATER_0_MAXTEMP 275
>DEFAULT_X_MAX_ACCELERATION 1000   >BED_MAXTEMP 150
>DEFAULT_XJERK 10.0
                                   >BLTOUCH 1             ← уже включён в ОБОИХ вариантах
>X_PROBE_OFFSET_FROM_EXTRUDER 27   >Z_MIN_PROBE_PIN_MODE 2  (2 = Z-MAX порт)
>Y_PROBE_OFFSET_FROM_EXTRUDER -6   >BED_LEVELING_METHOD 3   (multi-point ABL)
>Z_PROBE_OFFSET_FROM_EXTRUDER 0    >GRID_MAX_POINTS_X/Y 4
>XY_PROBE_SPEED 4000               >MESH_INSET 20
>Z_PROBE_SPEED_FAST/SLOW 800       >cfg_auto_leveling_cmd:G28;G29;
```

Копия файла: [`reference/stock/robin_nano_cfg.auto.txt`](../reference/stock/robin_nano_cfg.auto.txt).

### Что это значит для проекта

**Хорошо (но требует проверки):** есть основания думать, что поддержка BLTouch/ABL **уже
вкомпилирована** в стоковый бинарь — `cfg_auto_leveling_cmd:G28;G29;` не работал бы без `G29`
в прошивке, а кнопка «автолевелинг» на экране это просто макрос `G28;G29;`. Если так, то включение
автолевелинга на стоке — **правка одной строки в текстовом файле на SD-карте, без пересборки**.

**Но осторожно — эта цепочка вывода не доказана.** `BLTOUCH 1`, `Z_MIN_PROBE_PIN_MODE 2` и
`BED_LEVELING_METHOD 3` присутствуют **в обоих** cfg — в том числе в варианте для
ручного левелинга, где зонда физически нет. Это значит одно из двух:

- **(a)** `cfg_leveling_mode` гейтит, учитывается ли `BLTOUCH 1` вообще → тогда наличие
  `BLTOUCH 1` в файле **не является доказательством** поддержки зонда в бинаре;
- **(b)** принтеры без зонда просто едут со cfg, ссылающимся на несуществующее железо.

**[ПРОВЕРИТЬ]** — различие решается тестом Фазы 0: `M115` → `Cap:Z_PROBE` / `Cap:AUTOLEVEL`,
плюс `M851` и `M119`. До этого теста считать поддержку зонда в стоке **недоказанной**:
от неё зависит, дешёвая Фаза 3 или нет.

**Плохо/рискованно:** стоковая прошивка — это **закрытая MKS-сборка, параметризуемая текстовым
файлом**, а не ванильный Marlin. По документации MKS файл с SD применяется **однократно**
(«TF card files can only be updated once, after the update the files are automatically invalid»),
после чего значения живут во flash. Но:

- **[ПРОВЕРИТЬ]** отдаёт ли стоковая сборка полноценный GCode-контракт по USB:
  `M115` с `Cap:`-строками, `M503`, `M500`, `M301`/`M304`, `M303`, `M851`, `M420`.
- **[ПРОВЕРИТЬ]** реально ли `M500` переживает перезагрузку (у MKS-сборок исторически бывает
  `Error writing to EEPROM!`).

Если стоковая прошивка режет GCode-поверхность или `M500` не работает — **вся идея «настраиваю
из приложения и это сохраняется» рассыпается**. Поэтому Фаза 0 плана — это разведка, а не код.

---

## 3. Комьюнити-Marlin для KP5L: заведомо годная база

`spinixguy/KP5L-firmware` → `Kingroon-KP5L-Marlin-2.1.1-ABL.zip` — реальный `Configuration.h` +
`Configuration_adv.h` + `platformio.ini`. Что там включено (проверено грепом):

| Фича | Статус | Значение для 3DTune |
|---|---|---|
| `EEPROM_SETTINGS` | ✅ вкл | `M500`/`M501`/`M503` работают |
| `EEPROM_INIT_NOW` | ✅ вкл | инициализация при первой прошивке |
| `EXTENDED_CAPABILITIES_REPORT` | ✅ вкл | `M115` отдаёт `Cap:` — автодетект фич |
| `AUTO_REPORT_TEMPERATURES` | ✅ вкл | `M155 S<sec>` вместо опроса `M105` |
| `HOST_KEEPALIVE_FEATURE` | ✅ вкл | `busy: processing` — не считать таймаутом |
| `PIDTEMP` + `PIDTEMPBED` | ✅ вкл | `M303`/`M301`/`M304` для сопла И стола |
| `BLTOUCH`, `Z_MIN_PROBE_PIN PC4`, `SERVO0_PIN PA8` | ✅ вкл | 3D Touch поддержан |
| `NOZZLE_TO_PROBE_OFFSET { 34, -8, 0 }` | ✅ | `M851` редактируемо |
| `Z_SAFE_HOMING`, `LCD_BED_LEVELING` | ✅ вкл | |
| `AUTO_BED_LEVELING_UBL` | ⚠️ вкл | лучше заменить на BILINEAR — см. §5 |
| `BABYSTEPPING`, `LIN_ADVANCE` (K 0.22), `S_CURVE_ACCELERATION` | ✅ вкл | `M290`, `M900` |
| `EMERGENCY_PARSER` | ❌ **выкл** | **дефект безопасности** — см. §5 |
| `ADVANCED_OK` | ❌ выкл | нет глубины буфера в `ok` |
| `HOST_ACTION_COMMANDS` / `HOST_PROMPT_SUPPORT` | ❌ выкл | нет `//action:` и диалогов |
| `AUTO_REPORT_POSITION`, `M114_DETAIL` | ❌ выкл | позиция только по запросу |
| `PID_AUTOTUNE_MENU` / `PID_EDIT_MENU` | ❌ выкл | **PID с экрана не настроить вообще** |
| `BUFSIZE 4`, `BLOCK_BUFFER_SIZE 16`, `TX_BUFFER_SIZE 0` | — | узкий буфер, важно для пейсинга |

Последняя строка — прямое обоснование проекта: **PID на KP5L сейчас нельзя настроить с тачскрина
физически**. Только через хост.

Второй вариант базы: `mechano/Kingroon_KP5L_Marlin_Firmware` — Marlin 2.1.x bugfix, заявлены
input shaping, 25-точечный ABL, 5 языков, `HOST_ACTION_COMMANDS`. Исходников в репо нет
(только README + релизы) — **[ПРОВЕРИТЬ]** конфиг перед использованием.

---

## 4. EEPROM: жёсткое ограничение

Из pins-файла:
```c
#define FLASH_EEPROM_EMULATION
#define EEPROM_PAGE_SIZE     0x800U   // 2 КБ
#define MARLIN_EEPROM_SIZE   EEPROM_PAGE_SIZE
```

EEPROM **эмулируется во flash MCU**, всего **2 КБ**, ресурс страницы flash STM32F1 ≈ 10 000 циклов
стирания.

Правила для приложения, вытекающие отсюда:
- **никакого автосохранения при изменении поля.** Только явная кнопка «Сохранить в принтер».
- изменения **батчить**: применить пачку `M92`/`M201`/`M301`/… → один `M500`.
- показывать счётчик сохранений за сессию; предупреждать при частых записях.
- UBL-меш в 2 КБ может просто не поместиться (число слотов зависит от остатка места) →
  ещё одна причина уйти на BILINEAR, который хранит меш внутри общего блока `M500`.

---

## 5. Граница «живое / только пересборка» — главное продуктовое ограничение

Это надо понимать до начала работы, иначе будет разочарование.

### Настраивается по serial, на живом принтере (владение приложением — полное)

| Что | GCode |
|---|---|
| Шаги/мм XYZE | `M92` |
| Макс. скорости / ускорения / jerk | `M203` / `M201` `M204` / `M205` |
| Home offset, позиция | `M206`, `M114`, `G92` |
| PID сопла / стола | `M301` / `M304`, автотюн `M303 E0 S220 C8 U1` |
| Z-offset зонда | `M851 Z-1.23`, живая подстройка `M290 Z-0.02` |
| Меш: снять / включить / правка точки | `G29`, `M420 S1 V1`, `M421 I.. J.. Z..` |
| Linear Advance | `M900 K0.05` |
| Токи/режим TMC | `M906`/`M913`/`M914` — **на KP5L нет** (TMC2225 standalone) |
| Сохранить / загрузить / сброс | `M500` / `M501` / `M502` |
| Диагностика | `M119` (эндстопы), `M43` (пины), `M122` (TMC — н/д) |
| Управление | `G0/G1`, `G28`, `M104/M140`, `M106`, `M84`, `M112` |

### Только пересборка прошивки (`M503` этого не покажет никогда)

- **есть ли BLTouch вообще** и на каком пине
- какой алгоритм левелинга (BILINEAR / UBL / MBL)
- наличие Input Shaping, Linear Advance, Emergency Parser, Host Actions
- `HEATER_0_MAXTEMP`, `BED_MAXTEMP`, thermal protection
- назначение пинов, тип термистора, kinematics
- поведение тач-UI

**Главный ask пользователя — «3D Touch из одного приложения» — попадает на границу:**
*включить* его нельзя по serial, но *всё после включения* (offset, меш, Z-offset, калибровка,
пересъём сетки) — можно и полностью. Значит сценарий такой:

> одна прошивка с SD-карты один раз → дальше приложение владеет зондом навсегда.

Kingroon публикует готовый `.bin` с BLTouch, плюс есть проверенные комьюнити-сборки →
**на первую фазу компилятор не нужен вообще**.

### Прошивка: как и почему не из приложения

```ini
board_build.encrypt_mks = Robin_nano35.bin     # Marlin bugfix-2.1.x, env mks_robin_nano_v1v2_maple
```
Бинарь **шифруется под MKS-загрузчик** и заливается с SD-карты (`Robin_nano.bin` /
`Robin_nano35.bin` в корне, плата шьётся при включении). Прошить по USB нельзя без DFU/SWD,
а это риск убить MKS-загрузчик. **Вывод: обновление прошивки остаётся SD-операцией. Всегда.**
Приложение может максимум *собрать* `.bin` (см. отложенные фичи) — но не залить.

---

## 6. Профиль прошивки «3DTune» — что обязательно включить

Поверх комьюнити-конфига KP5L:

| Define | Зачем | Приоритет |
|---|---|---|
| `EMERGENCY_PARSER` | без него `M112`/`M410`/`M108` встают в очередь за буфером. Для приложения, которое гоняет сопло на 240 °C восемь циклов `M303`, кнопка STOP, срабатывающая «через пару секунд» — это **дефект, а не неудобство** | **P0** |
| `ADVANCED_OK` | реальная глубина буфера в `ok N.. P.. B..`; при `BUFSIZE 4` и `TX_BUFFER_SIZE 0` без этого корректный пейсинг не сделать | **P0** |
| `EEPROM_SETTINGS` | уже вкл — не выключать | P0 |
| `AUTO_BED_LEVELING_BILINEAR` **вместо** `AUTO_BED_LEVELING_UBL` | UBL требует явных `G29 S<slot>`/`G29 L<slot>`, число слотов зависит от остатка 2 КБ flash-EEPROM (может быть 0). BILINEAR хранит меш внутри блока `M500`, управляется `G29` / `M420 S1 V1` / `M421` — приложению владеть этим кардинально проще | **P0** |
| `HOST_ACTION_COMMANDS` + `HOST_PROMPT_SUPPORT` | принтер сам умеет просить у хоста подтверждение (`//action:prompt_*`) — нужно для сценариев с паузами | P1 |
| `AUTO_REPORT_POSITION`, `M114_DETAIL` | живая позиция без polling | P1 |
| `PID_EDIT_MENU`, `PID_AUTOTUNE_MENU` | опционально, если хочется дублирования на экране | P2 |
| `GCODE_MACROS` | пользовательские макросы в прошивке | P2 |
| Урезать тач-UI до статус-дисплея | пользователь хочет «совсем не трогать экран»; убирает риск рассинхрона состояния между двумя источниками команд | P2 (по желанию) |
| `USB_MOD` (native USB CDC, ~1.5 Мбит/с) | требует **аппаратной переделки**: перекинуть эндстопы Y/Z-min с PA11/PA12 на PB10/PB11 + развести USB D+/D−. Не для v1 | Отложено |

---

## 7. Отклонённые альтернативы (чтобы не возвращаться к спору)

**Klipper.** Формально идеально ложится на сценарий «принтер постоянно подключён к ПК»: ПК был бы
хостом, плата — MCU, вся конфигурация — живой текстовый файл, есть input shaper, resonance testing,
PID. Kingroon даже продаёт Klipper-плату «KP Cheetah».
**Отклонено:** `klippy` — Linux-only. На Windows нужен WSL2 + `usbipd-win`, и это хрупко
(при переподключении USB устройство пропадает из WSL, пока вручную не сделать `usbipd attach`).
На macOS официально не поддерживается вообще. Требование «Windows + macOS» это убивает.

**OctoPrint как ядро.** Тянет Python-рантайм и веб-стек, спроектирован под «поставил и забыл на
Pi», плагины под наши задачи разрозненные. Как desktop-приложение упаковывается плохо.

**Форк Pronterface/Printrun UI.** UI устарел (wx), но `printcore` — боевая, годами
оттестированная реализация протокола Marlin. **Решение: не зависеть, а читать как спецификацию**
при написании своего транспорта.

**Собственная прошивка «в симбиозе с ПК».** Пользователь описал идею как «по совместительству
прошивка». Технически это не нужно и вредно: стандартный Marlin GCode-контракт уже даёт всё,
что требуется, а своя прошивка = свой риск окирпичивания + потеря совместимости со слайсерами.
Правильная формулировка: **3DTune — это хост, а не прошивка.**

---

## 8. Ссылки

- [Kingroon: установка BLTouch на KP5L (+ прошивки)](https://kingroon.com/blogs/downloads/install-bltouch-leveling-sensor-on-kingroon-kp5-with-marlin-firmware)
- [Kingroon: прошивки KP5L](https://kingroon.com/blogs/downloads/kingroon-kp5l-firmware-to-download)
- [spinixguy/KP5L-firmware](https://github.com/spinixguy/KP5L-firmware) — стоковые архивы + Marlin 2.1.1 ABL/MBL конфиги
- [mechano/Kingroon_KP5L_Marlin_Firmware](https://github.com/mechano/Kingroon_KP5L_Marlin_Firmware) — Marlin 2.1.x bugfix
- [Marlin: M115 Firmware Info / Cap-строки](https://marlinfw.org/docs/gcode/M115.html)
- [Marlin: M155 Temperature Auto-Report](https://marlinfw.org/docs/gcode/M155.html)
- [Marlin: pins_MKS_ROBIN_NANO_common.h](https://github.com/MarlinFirmware/Marlin/blob/bugfix-2.1.x/Marlin/src/pins/stm32f1/pins_MKS_ROBIN_NANO_common.h)
- [RepRap: PID Tuning](https://reprap.org/wiki/PID_Tuning)
- [MKS Robin Nano V1.X wiki](https://github.com/makerbase-mks/MKS-Robin-Nano-V1.X)
- [WCH CH34x macOS driver](https://github.com/WCHSoftGroup/ch34xser_macos)
- [usbipd-win (для контекста отклонения Klipper)](https://github.com/dorssel/usbipd-win)
